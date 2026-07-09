/**
 * Site Discovery Crawler
 *
 * Autonomous crawler that discovers web application structure using Crawlee.
 * Integrates with AuthDetector and persists results to database.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    Configuration,
    MemoryStorage,
    PlaywrightCrawler,
    type PlaywrightCrawlingContext,
    RequestQueue,
} from "crawlee";
import type { Page, Response } from "playwright";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import {
    type BlockerDetector,
    createAuthDetector,
    createManualFallbackDetector,
    runBlockerPipeline,
} from "./detectors";
import { looksLikeLoginUrl } from "./detectors/auth";
import { buildLinkSelector, mergeBlockedUrlIntoQueue, safeOrigin } from "./link-utils";
import type { BlockerCategory, DiscoveryBlocker, DiscoveryOptions, DiscoveryStats } from "./types";
import { normalizeUrl } from "./url-utils";

type StorageStateCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    url?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
};

type StorageStateInput = {
    cookies?: StorageStateCookie[];
    origins?: Array<{
        origin: string;
        localStorage?: Array<{ name: string; value: string }>;
    }>;
};

/**
 * Extract the visible form controls on a page as structured, selector-friendly
 * metadata (label/type/name/id/placeholder per field + submit-button labels).
 * Runs entirely in the page context so it works for any framework. Best-effort:
 * returns null on failure or when the page has no meaningful form controls, so
 * a busted page never aborts the crawl. Persisted per page (forms_json) and fed
 * to test generation so specs reference real fields instead of guessing them.
 */
async function extractPageForms(page: Page): Promise<string | null> {
    try {
        const forms = await page.evaluate(() => {
            const isVisible = (el: Element): boolean => {
                const he = el as HTMLElement;
                if (he.hidden) return false;
                const style = window.getComputedStyle(he);
                if (style.display === "none" || style.visibility === "hidden") return false;
                // offsetParent is null for display:none / detached; allow position:fixed.
                return he.offsetParent !== null || style.position === "fixed";
            };

            const labelFor = (el: Element): string => {
                const aria = el.getAttribute("aria-label");
                if (aria?.trim()) return aria.trim();
                const labelledby = el.getAttribute("aria-labelledby");
                if (labelledby) {
                    const text = labelledby
                        .split(/\s+/)
                        .map((id) => document.getElementById(id)?.textContent || "")
                        .join(" ")
                        .trim();
                    if (text) return text;
                }
                const id = (el as HTMLInputElement).id;
                if (id) {
                    const escaped =
                        typeof CSS !== "undefined" && CSS.escape
                            ? CSS.escape(id)
                            : id.replace(/"/g, '\\"');
                    const label = document.querySelector(`label[for="${escaped}"]`);
                    if (label?.textContent?.trim()) return label.textContent.trim();
                }
                const wrapping = el.closest("label");
                if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
                return (el.getAttribute("placeholder") || el.getAttribute("name") || "").trim();
            };

            const fieldEls = Array.from(
                document.querySelectorAll("input, select, textarea"),
            ).filter((el) => {
                const type = (el.getAttribute("type") || "").toLowerCase();
                if (type === "hidden") return false;
                return isVisible(el);
            });

            const fields = fieldEls.slice(0, 40).map((el) => {
                const tag = el.tagName.toLowerCase();
                const placeholder = el.getAttribute("placeholder");
                const name = el.getAttribute("name");
                const idAttr = (el as HTMLInputElement).id;
                const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
                return {
                    label: labelFor(el).slice(0, 100),
                    type: (el.getAttribute("type") || tag).toLowerCase(),
                    required:
                        el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
                    placeholder: placeholder ? placeholder.slice(0, 100) : undefined,
                    name: name || undefined,
                    id: idAttr || undefined,
                    testId: testId || undefined,
                };
            });

            const submits = Array.from(
                document.querySelectorAll(
                    "button, input[type=submit], input[type=button], [role=button]",
                ),
            )
                .filter((el) => isVisible(el))
                .map((el) =>
                    (
                        el.textContent ||
                        el.getAttribute("value") ||
                        el.getAttribute("aria-label") ||
                        ""
                    )
                        .trim()
                        .slice(0, 60),
                )
                .filter((text) => text.length > 0)
                .slice(0, 15);

            return { fields, submits };
        });

        if (forms.fields.length === 0 && forms.submits.length === 0) return null;
        return JSON.stringify(forms);
    } catch {
        return null;
    }
}

export class SiteDiscovery extends EventEmitter {
    private crawler: PlaywrightCrawler | null = null;
    private db: CodeGraphDB;
    private siteDb: SiteKnowledgeDB;
    private detectors: BlockerDetector[];
    private options: Required<DiscoveryOptions>;
    private sessionId: number | null = null;
    private stats: DiscoveryStats;
    private visitedUrls = new Set<string>();
    private isPaused = false;
    private startOrigin: string | null = null;
    private requestQueue: RequestQueue | null = null;
    /**
     * Per-instance queue name. Crawlee's `RequestQueue.open(name)` caches
     * by name, so repeated `open()` with the default `null`/`"default"`
     * key returns the SAME wrapped queue across discovery sessions —
     * carrying over the prior run's "URL already handled" markers and
     * causing the next fresh crawl to drain immediately with 0 pages.
     *
     * Swapping in a fresh `MemoryStorage` (see `start()`) is necessary
     * but not sufficient: the cached `RequestQueue` instance still
     * dedupes against its in-memory request log. Giving every
     * `SiteDiscovery` instance a unique queue name forces a clean
     * cache miss and a brand-new queue. Memory cost is negligible —
     * dropping the queue on `close()` reclaims the entry.
     *
     * Public-ish so the `purgeQueueOnResume` path can reuse it.
     */
    private readonly queueName: string;
    private queuedRequests: Array<{
        url: string;
        uniqueKey?: string;
        userData?: Record<string, unknown>;
    }> | null = null;
    /**
     * URLs enqueued but not yet successfully visited, keyed by normalized URL.
     * This is our own source of truth for "what's left to crawl" because
     * Crawlee runs with `persistStorage: false` (an in-memory queue that never
     * writes to disk), so there is no on-disk queue file to read for resume.
     * We persist THIS map to `crawl_session.queueJson` and re-seed from it.
     */
    private pendingRequests = new Map<
        string,
        { url: string; uniqueKey: string; userData?: Record<string, unknown> }
    >();
    /**
     * Sanitised storage state ready to hand directly to
     * `browser.newContext({ storageState })` via Crawlee's
     * `prePageCreateHooks`. Applying it at context-creation time (rather than
     * via `addInitScript` after navigation) is critical: it guarantees both
     * cookies AND localStorage are seeded *before* the SPA's first script
     * runs. With the previous addInitScript approach, SPAs that read auth
     * tokens from localStorage on mount saw an empty store on the very first
     * navigation, redirected to /login, and tripped the AuthDetector — even
     * though the saved auth-state.json was perfectly valid.
     */
    private playwrightStorageState: {
        cookies: StorageStateCookie[];
        origins: Array<{
            origin: string;
            localStorage: Array<{ name: string; value: string }>;
        }>;
    } | null = null;
    private storageStateWarningEmitted = false;
    /** Set once a request returns a real authenticated page. */
    private hasSeenAuthenticatedSuccess = false;
    private wallClockTimer: NodeJS.Timeout | null = null;
    private aborted = false;
    private snapshotFailureReports = 0;
    private compiledExcludeMatchers: Array<(url: string) => boolean> = [];
    /**
     * Session-scoped resolution memory.
     *
     * `skippedUrls`         URLs the user told us to skip after a blocker.
     * `ignoredCategories`   blocker categories downgraded to `severity: "log"`
     *                       for the rest of this session ("don't pause for
     *                       captchas again, just record them").
     *
     * Both survive a pause/resume cycle via the `discovery_sessions` row
     * (`skipped_urls_json` / `ignored_categories_json` columns).
     */
    private skippedUrls = new Set<string>();
    private ignoredCategories = new Set<BlockerCategory>();

    /**
     * URLs currently being processed by a worker. Acts as a short-lived
     * lock so two concurrent workers don't both render the same page.
     * Cleared in a `finally` so a thrown handler always releases its
     * slot; otherwise the URL would be permanently un-retryable.
     */
    private inFlightUrls = new Set<string>();

    /**
     * Records *why* a URL never produced a discovered page. Populated by
     * the failed-request handler (Playwright nav errors, retry exhaustion,
     * SSL failures, anti-bot blocks where the browser process died, ...)
     * and surfaced in the user-facing "No pages discovered" diagnostic.
     */
    private failedRequests: Array<{ url: string; reason: string; status: number | null }> = [];

    /**
     * Resolved URLs (post-redirect) that look like a login/auth page but
     * which no detector flagged. Surfaced in the empty-crawl diagnostic
     * so users running `raiken discover` directly against a login URL
     * (or sites that hide the password field behind OAuth/magic-link)
     * still get an actionable hint instead of the generic fallback.
     *
     * Bounded — we only track up to 5 distinct URLs to avoid unbounded
     * growth on huge crawls of login-heavy site sections.
     */
    private resolvedLoginShapedUrls = new Set<string>();

    /**
     * Set to `true` the first time `handleRequest` is entered. Used by
     * `buildEmptyCrawlError` to distinguish:
     *
     *   - Pages were dispatched but produced no usable content
     *     (handler ran → handlerInvoked = true → existing diagnostics apply)
     *
     *   - The crawler ran with a non-empty startUrls list yet the
     *     handler never fired (handlerInvoked = false → silent drain)
     *
     * The silent-drain branch is the symptom of Crawlee's `RequestQueue`
     * having previously marked the URL as handled, so `addRequests`
     * deduped it away and `run()` returned in <300ms with `requestsTotal: 0`.
     * The unique queue name + drop-on-close fix prevents this in normal
     * use, but we keep the diagnostic as an unmistakeable signal if it
     * ever recurs (e.g. a future Crawlee version changes its caching).
     */
    private handlerInvoked = false;

    constructor(options: DiscoveryOptions) {
        super();

        // Set defaults
        this.options = {
            startUrl: options.startUrl,
            projectPath: options.projectPath,
            maxPages: options.maxPages ?? 100,
            maxDepth: options.maxDepth ?? 5,
            maxConcurrency: options.maxConcurrency ?? 3,
            timeout: options.timeout ?? 30000,
            excludePatterns: options.excludePatterns ?? [],
            pauseOnAuth: options.pauseOnAuth ?? true,
            storageStatePath: options.storageStatePath ?? null,
            continueSession: options.continueSession ?? false,
            purgeQueueOnResume: options.purgeQueueOnResume ?? false,
            maxRunTimeMs: options.maxRunTimeMs ?? 30 * 60 * 1000,
            preserveQueryParams: options.preserveQueryParams ?? false,
        };

        this.compiledExcludeMatchers = this.options.excludePatterns.map(compileExcludeMatcher);

        // Per-instance Crawlee queue name. See `queueName` field doc for
        // why the default `"default"` would silently break run-after-clear.
        this.queueName = `raiken-discovery-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;

        // Initialize database
        this.db = new CodeGraphDB(this.options.projectPath);
        this.siteDb = new SiteKnowledgeDB(
            this.db.getRawDatabase(),
            this.options.projectPath,
            this.options.preserveQueryParams,
        );

        // Initialise the blocker detector pipeline. Order is by `priority`
        // — the manual-fallback detector runs first so a 5xx page or a
        // captcha iframe wins over a same-page auth signal.
        this.detectors = [createManualFallbackDetector(), createAuthDetector()];

        // Initialize stats
        this.stats = {
            pagesDiscovered: 0,
            linksFound: 0,
            authBlockersFound: 0,
            currentDepth: 0,
            currentUrl: null,
            status: "running",
            startedAt: Date.now(),
            elapsedMs: 0,
        };
    }

    /**
     * Start the discovery process.
     */
    async start(): Promise<void> {
        try {
            // Direct Crawlee's file-based storage into .raiken/crawlee/.
            // We keep the directory around for diagnostic dumps but
            // disable on-disk persistence below.
            const crawleeDir = path.join(this.options.projectPath, ".raiken", "crawlee");
            fs.mkdirSync(crawleeDir, { recursive: true });
            process.env["CRAWLEE_STORAGE_DIR"] = crawleeDir;

            // CRITICAL: install a fresh, in-memory-only `MemoryStorage`
            // for *every* discovery run.
            //
            // Why this is the right shape of the fix (and the previous
            // attempts weren't):
            //
            // Crawlee's storage client is a process-global singleton.
            // Within a long-lived CLI server we run many discovery
            // sessions back-to-back, and the singleton accumulates state:
            //
            //   1. The default `RequestQueue` keeps "URL already handled"
            //      markers from prior runs, so a second crawl on the
            //      same start URL drains immediately with 0 pages.
            //
            //   2. The default `KeyValueStore` holds a live in-memory
            //      handle to `SDK_SESSION_POOL_STATE.json` from a prior
            //      run's SessionPool. Any subsequent purge-on-disk
            //      attempt yanks the file out from under that handle
            //      and the next read/write throws
            //      `Could not find file at .../SDK_SESSION_POOL_STATE.json`,
            //      crashing the new crawl.
            //
            // Both problems vanish when each run gets a brand-new
            // `MemoryStorage`. The old one (with all its stale handles
            // and "handled URL" log) is dereferenced and GCed; the new
            // one has empty in-memory caches and never touches disk
            // (`persistStorage: false`), so there's nothing on disk to
            // race with the prior run's references.
            //
            // We deliberately drop `persistStorage` because Crawlee's
            // on-disk persistence is redundant for us: cross-process resume
            // goes through the discovery session row in SQLite (queueJson,
            // persisted via `persistQueueState` from our in-memory
            // `pendingRequests` map), and within a single run an in-memory
            // queue is strictly faster.
            const fresh = new MemoryStorage({
                localDataDirectory: crawleeDir,
                persistStorage: false,
            });
            Configuration.getGlobalConfig().useStorageClient(fresh);
            // Belt-and-braces: even with our fresh client, leave
            // `purgeOnStart` enabled so any code path that fetches a
            // *cached* singleton (e.g. inside Crawlee internals that
            // pre-resolved the client at module load) still gets a
            // clean slate.
            Configuration.getGlobalConfig().set("purgeOnStart", true);

            // Check if resuming a session
            if (this.options.continueSession) {
                await this.resumeSession();
            } else {
                await this.startNewSession();
            }

            this.startOrigin = this.getOriginSafe(this.options.startUrl);
            if (!this.startOrigin) {
                throw new Error("Start URL is invalid or missing");
            }

            this.loadStorageState();

            this.requestQueue = await RequestQueue.open(this.queueName);

            if (this.queuedRequests && this.queuedRequests.length > 0) {
                await this.requestQueue.addRequests(
                    this.queuedRequests.map((request) => ({
                        url: request.url,
                        uniqueKey: request.uniqueKey,
                        userData: request.userData,
                    })),
                );
                // Mirror the re-seeded queue into our pending map so a second
                // pause/resume still knows what remains.
                for (const request of this.queuedRequests) {
                    const key = request.uniqueKey ?? this.normalizeUrl(request.url);
                    this.pendingRequests.set(key, {
                        url: request.url,
                        uniqueKey: key,
                        userData: request.userData,
                    });
                }
            }

            // Navigation timeout governs a single goto(); the request handler
            // does navigation + DOM extraction + link enqueue, so it gets a
            // generous multiple. Without this, slow pages timeout mid-extract
            // and we lose the snapshot.
            const navTimeoutSecs = Math.max(this.options.timeout, 5_000) / 1000;
            const handlerTimeoutSecs = Math.max(navTimeoutSecs * 3, 60);

            const storageStateForContext = this.playwrightStorageState;

            // Crawlee's `maxRequestsPerCrawl` counts EVERY dispatched request
            // — including ones we reject (excluded patterns, blockers, off-
            // origin redirects, dedup misses). If we set it equal to
            // `maxPages` then a site with many gated routes hits the cap
            // long before we've discovered `maxPages` *real* pages. Give
            // Crawlee 50% headroom (with a floor of +10) and enforce the
            // hard cap ourselves in `handleRequest`.
            const crawleeRequestCap = Math.max(
                Math.ceil(this.options.maxPages * 1.5),
                this.options.maxPages + 10,
            );

            this.crawler = new PlaywrightCrawler({
                maxRequestsPerCrawl: crawleeRequestCap,
                maxConcurrency: this.options.maxConcurrency,
                requestHandlerTimeoutSecs: handlerTimeoutSecs,
                navigationTimeoutSecs: navTimeoutSecs,
                headless: true,
                requestQueue: this.requestQueue,
                launchContext: {
                    launchOptions: {},
                    // `pageOptions.storageState` is only honored by Playwright's
                    // `browser.newContext()` path, which Crawlee uses when each
                    // page gets its own (incognito) context. With shared
                    // contexts (the default), `pageOptions` is `undefined` and
                    // the hook below is a no-op.
                    ...(storageStateForContext ? { useIncognitoPages: true } : {}),
                },
                browserPoolOptions: storageStateForContext
                    ? {
                          prePageCreateHooks: [
                              (_pageId, _browserController, pageOptions) => {
                                  if (pageOptions) {
                                      (pageOptions as { storageState?: unknown }).storageState =
                                          storageStateForContext;
                                  }
                              },
                          ],
                      }
                    : undefined,
                // Capture nav-level failures (DNS errors, SSL errors, retry
                // exhaustion, anti-bot blocks that crash the page, ...).
                // Without this, Crawlee silently drops failed requests and
                // we'd report "0 pages discovered" with no diagnostic.
                failedRequestHandler: async ({ request, response }, error) => {
                    const status =
                        typeof response?.status === "function" ? response.status() : null;
                    const reason = this.summariseFailure(error, status);
                    this.failedRequests.push({ url: request.url, reason, status });
                    this.emit("warning", {
                        type: "warning",
                        data: {
                            url: request.url,
                            message: `Request failed: ${reason}`,
                            status,
                        },
                        timestamp: Date.now(),
                    });
                },
            });

            // Bind request handler to this instance
            this.crawler.router.addDefaultHandler(this.handleRequest.bind(this));

            // Start crawling. On resume:
            //   - With a hydrated queue (normal continue), let Crawlee
            //     drain it; don't double-seed startUrl.
            //   - Without one (or with `purgeQueueOnResume`), seed startUrl
            //     so the crawler has something to do.
            const startUrls =
                this.options.continueSession &&
                this.queuedRequests?.length &&
                !this.options.purgeQueueOnResume
                    ? []
                    : [this.options.startUrl];

            // Track the initial seed in our pending map too (Crawlee's queue is
            // in-memory only, so this is what resume relies on).
            for (const seed of startUrls) {
                const key = this.normalizeUrl(seed);
                this.pendingRequests.set(key, {
                    url: seed,
                    uniqueKey: key,
                    userData: { depth: 0 },
                });
            }

            // On resume with no live queue, detect the dead-end case: Crawlee's
            // on-disk RequestQueue may already have this URL marked handled, in
            // which case `run()` returns instantly with no pages processed and
            // no user-visible signal. Pre-check the queue and surface a clear
            // event + mark the session complete so the UI stops spinning.
            if (this.options.continueSession) {
                const queueIsEmpty = await this.requestQueue.isEmpty();
                const nothingToDo =
                    queueIsEmpty &&
                    (!this.queuedRequests || this.queuedRequests.length === 0) &&
                    startUrls.length === 0;
                if (nothingToDo) {
                    // The dashboard surfaces this in the timeline; printing
                    // to stdout would noise up the CLI for non-TTY agent
                    // mode (background jobs, CI runs).
                    this.emit("warning", {
                        type: "warning",
                        data: {
                            url: this.options.startUrl,
                            message:
                                "Resume requested but no pending work remained in the queue. Marking session complete.",
                        },
                        timestamp: Date.now(),
                    });
                    this.stats.status = "completed";
                    this.stats.elapsedMs = Date.now() - this.stats.startedAt;
                    if (this.sessionId) {
                        this.siteDb.updateSession(this.sessionId, {
                            status: "completed",
                            completedAt: Date.now(),
                            pagesDiscovered: this.stats.pagesDiscovered,
                            linksFound: this.stats.linksFound,
                        });
                    }
                    this.emit("session_completed", {
                        type: "session_completed",
                        data: { stats: this.stats },
                        timestamp: Date.now(),
                    });
                    return;
                }
            }

            // Wall-clock cap: even with maxPages/maxDepth honored, a slow site
            // with thousands of in-scope links can crawl far longer than the
            // user expects. Pause gracefully when we hit the deadline.
            this.armWallClockTimer();

            try {
                await this.crawler.run(startUrls);
            } finally {
                this.disarmWallClockTimer();
            }

            if (this.isPaused) {
                this.stats.elapsedMs = Date.now() - this.stats.startedAt;
                return;
            }

            if (this.aborted) {
                this.stats.elapsedMs = Date.now() - this.stats.startedAt;
                this.stats.status = "completed";
                if (this.sessionId) {
                    this.siteDb.updateSession(this.sessionId, {
                        status: "completed",
                        completedAt: Date.now(),
                        pagesDiscovered: this.stats.pagesDiscovered,
                        linksFound: this.stats.linksFound,
                    });
                }
                this.emit("session_completed", {
                    type: "session_completed",
                    data: { stats: this.stats, reason: "aborted" },
                    timestamp: Date.now(),
                });
                return;
            }

            // S6: a fresh crawl that completes with zero pages discovered is
            // almost always a bogus start URL, network error, or 100%-excluded
            // host — surface it as an error instead of a "complete" success.
            // We append whatever diagnostic context we managed to capture
            // (failed requests + reasons, blockers detected) so the user gets
            // an actionable message instead of a generic "is the URL
            // reachable" prompt.
            const isFreshCrawl = !this.options.continueSession;
            if (isFreshCrawl && this.stats.pagesDiscovered === 0) {
                const message = this.buildEmptyCrawlError();
                this.stats.status = "failed";
                if (this.sessionId) {
                    this.siteDb.updateSession(this.sessionId, {
                        status: "failed",
                        completedAt: Date.now(),
                    });
                }
                this.emit("error", {
                    type: "error",
                    data: { error: new Error(message) },
                    timestamp: Date.now(),
                });
                return;
            }

            // Mark session as completed
            this.stats.status = "completed";
            this.stats.elapsedMs = Date.now() - this.stats.startedAt;

            if (this.sessionId) {
                this.siteDb.updateSession(this.sessionId, {
                    status: "completed",
                    completedAt: Date.now(),
                    pagesDiscovered: this.stats.pagesDiscovered,
                    linksFound: this.stats.linksFound,
                });
            }

            this.emit("session_completed", {
                type: "session_completed",
                data: { stats: this.stats },
                timestamp: Date.now(),
            });
        } catch (error) {
            this.disarmWallClockTimer();
            this.stats.status = "failed";
            this.emit("error", {
                type: "error",
                data: { error: error as Error },
                timestamp: Date.now(),
            });
            throw error;
        }
    }

    /**
     * Abort the current crawl. Marks the session complete (no resume) and
     * tears down the crawler. Intended for the dashboard "Stop" button when
     * the user wants to keep what was found but stop crawling further.
     */
    async abort(): Promise<void> {
        this.aborted = true;
        this.stats.status = "completed";
        this.disarmWallClockTimer();
        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status: "completed",
                completedAt: Date.now(),
                pagesDiscovered: this.stats.pagesDiscovered,
                linksFound: this.stats.linksFound,
            });
        }
        if (this.crawler) {
            try {
                await this.crawler.teardown();
            } catch {
                // ignore teardown errors during abort
            }
        }
    }

    private armWallClockTimer(): void {
        const cap = this.options.maxRunTimeMs;
        if (!cap || cap <= 0) return;
        this.wallClockTimer = setTimeout(() => {
            console.warn(
                `Discovery hit wall-clock cap of ${Math.round(cap / 1000)}s — pausing.`,
            );
            void this.pause().catch(() => {
                // pause failures shouldn't crash the timer
            });
        }, cap);
        // Don't keep the process alive solely for this timer.
        if (typeof this.wallClockTimer.unref === "function") {
            this.wallClockTimer.unref();
        }
    }

    private disarmWallClockTimer(): void {
        if (this.wallClockTimer) {
            clearTimeout(this.wallClockTimer);
            this.wallClockTimer = null;
        }
    }

    /**
     * Pause the discovery process.
     */
    async pause(options: { blockedAtUrl?: string | null } = {}): Promise<void> {
        this.isPaused = true;
        this.stats.status = "paused";

        // Treat in-flight URLs as still pending so a mid-request pause
        // doesn't drop the page that was being crawled when we stopped.
        for (const url of this.inFlightUrls) {
            const key = this.normalizeUrl(url);
            if (!this.pendingRequests.has(key) && !this.visitedUrls.has(key)) {
                this.pendingRequests.set(key, {
                    url,
                    uniqueKey: key,
                    userData: { depth: 0, resumedFromInFlight: true },
                });
            }
        }

        if (options.blockedAtUrl) {
            const key = this.normalizeUrl(options.blockedAtUrl);
            this.pendingRequests.set(key, {
                url: options.blockedAtUrl,
                uniqueKey: key,
                userData: { depth: 0, resumeBlocked: true },
            });
        }

        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status: "paused",
                ...(options.blockedAtUrl ? { blockedAtUrl: options.blockedAtUrl } : {}),
            });
        }

        await this.persistQueueState();

        this.emit("session_paused", {
            type: "session_paused",
            data: { stats: this.stats },
            timestamp: Date.now(),
        });

        // Gracefully stop the crawler. Guarded for the same reason as
        // `close()` — Crawlee's `teardown` throws if `sessionPool` was
        // never created, e.g. when `pause()` is called before `run()`
        // finished its setup phase.
        if (this.crawler) {
            try {
                await this.crawler.teardown();
            } catch {
                // Best-effort cleanup; don't bring the session down with us.
            }
        }
    }

    /**
     * Resume a paused session.
     */
    private async resumeSession(): Promise<void> {
        const activeSession = this.siteDb.getActiveSession();

        if (!activeSession) {
            throw new Error("No active session to resume");
        }

        this.sessionId = activeSession.id ?? null;
        this.stats.pagesDiscovered = activeSession.pagesDiscovered;
        this.stats.linksFound = activeSession.linksFound;
        this.stats.startedAt = activeSession.startedAt;

        // When the caller asked us to start fresh (typical after a real
        // auth handoff: the post-login DOM exposes a totally different
        // link graph), resume from the original session start URL rather
        // than the pause point. Otherwise default to "retry the URL we
        // paused on, then keep draining the queue".
        const resumeUrl = this.options.purgeQueueOnResume
            ? activeSession.startUrl
            : activeSession.blockedAtUrl || activeSession.startUrl;
        if (!resumeUrl) {
            throw new Error("Active session missing start URL");
        }
        this.options.startUrl = resumeUrl;

        if (typeof activeSession.maxPages === "number") {
            this.options.maxPages = activeSession.maxPages;
        }
        if (typeof activeSession.maxDepth === "number") {
            this.options.maxDepth = activeSession.maxDepth;
        }

        if (!this.options.purgeQueueOnResume) {
            let parsed: Array<{
                url: string;
                uniqueKey?: string;
                userData?: Record<string, unknown>;
            }> = [];
            if (activeSession.queueJson) {
                try {
                    const raw = JSON.parse(activeSession.queueJson) as Array<{
                        url: string;
                        uniqueKey?: string;
                        userData?: Record<string, unknown>;
                    }>;
                    parsed = Array.isArray(raw) ? raw.filter((item) => Boolean(item?.url)) : [];
                } catch {
                    parsed = [];
                }
            }

            // Always re-seed the pause point. On blocker pause the blocked URL
            // is removed from pendingRequests (marked committed) before
            // queue_json is written, so without this merge resume would drain
            // siblings and never retry the page that actually blocked.
            this.queuedRequests = mergeBlockedUrlIntoQueue(
                parsed,
                activeSession.blockedAtUrl,
                (url) => this.normalizeUrl(url),
            );
            if (this.queuedRequests.length === 0) {
                this.queuedRequests = null;
            }
        }

        if (activeSession.skippedUrlsJson) {
            try {
                const parsed = JSON.parse(activeSession.skippedUrlsJson) as unknown;
                if (Array.isArray(parsed)) {
                    for (const entry of parsed) {
                        if (typeof entry === "string") {
                            this.skippedUrls.add(entry);
                        }
                    }
                }
            } catch {
                // Ignore malformed memory; better to over-crawl than to crash.
            }
        }

        if (activeSession.ignoredCategoriesJson) {
            try {
                const parsed = JSON.parse(activeSession.ignoredCategoriesJson) as unknown;
                if (Array.isArray(parsed)) {
                    for (const entry of parsed) {
                        if (typeof entry === "string") {
                            this.ignoredCategories.add(entry as BlockerCategory);
                        }
                    }
                }
            } catch {
                // Ignore malformed memory.
            }
        }

        // Check for auth state file
        const authStatePath = path.join(this.options.projectPath, ".raiken", "auth-state.json");

        if (fs.existsSync(authStatePath) && !this.options.storageStatePath) {
            this.options.storageStatePath = authStatePath;
        }

        // Update session status
        if (!activeSession.id) {
            throw new Error("Active session is missing an ID");
        }

        this.siteDb.updateSession(activeSession.id, {
            status: "running",
        });

        this.emit("session_resumed", {
            type: "session_resumed",
            data: { stats: this.stats },
            timestamp: Date.now(),
        });
    }

    /**
     * Start a new discovery session.
     */
    private async startNewSession(): Promise<void> {
        // Check for auth state file
        const authStatePath = path.join(this.options.projectPath, ".raiken", "auth-state.json");

        if (fs.existsSync(authStatePath) && !this.options.storageStatePath) {
            this.options.storageStatePath = authStatePath;
        }

        // Create session in database
        this.sessionId = this.siteDb.saveSession({
            projectPath: this.options.projectPath,
            startUrl: this.options.startUrl,
            status: "running",
            pagesDiscovered: 0,
            linksFound: 0,
            startedAt: this.stats.startedAt,
            completedAt: null,
            blockedAtUrl: null,
            queueJson: null,
            maxPages: this.options.maxPages,
            maxDepth: this.options.maxDepth,
        });
    }

    /**
     * Handle a single page request.
     *
     * Lifecycle invariants this method enforces:
     *
     *   1. `visitedUrls` is committed only when the URL has reached a
     *      *definitive* outcome (saved page, exclusion, blocker, HTTP
     *      error, off-origin redirect, hard skip). Transient failures
     *      (browser closed mid-handler, navigation timeout that throws
     *      after settle, snapshot/title throws) leave the URL un-visited
     *      so Crawlee's retry layer can take another shot — without that,
     *      a single torn-down page leaks a permanent gap in the crawl.
     *      This was the root cause of the "Snapshot failed at /about"
     *      pages that vanished from the timeline.
     *
     *   2. `inFlightUrls` is held for the duration of the handler so two
     *      concurrent workers can't race on the same normalized URL, and
     *      is always released in `finally`.
     *
     *   3. `pagesDiscovered` is checked against `maxPages` BEFORE doing
     *      any expensive work, because Crawlee's `maxRequestsPerCrawl` is
     *      now intentionally larger than `maxPages` (see `start()`) to
     *      give the queue headroom for blocked / excluded / redirected
     *      requests that don't count toward the user's cap.
     */
    private async handleRequest(context: PlaywrightCrawlingContext): Promise<void> {
        const { page, request, response } = context;
        const url = request.url;
        const depth = (request.userData["depth"] as number) || 0;

        // Set BEFORE the pause check — we want to know that the handler
        // was reached at all, not just that it ran to completion.
        this.handlerInvoked = true;

        if (this.isPaused) {
            return;
        }

        this.stats.currentUrl = url;
        this.stats.currentDepth = Math.max(this.stats.currentDepth, depth);

        if (depth > this.options.maxDepth) {
            return;
        }

        if (this.shouldExclude(url)) {
            return;
        }

        const normalizedUrl = this.normalizeUrl(url);

        // Hard cap on saved pages. Crawlee's `maxRequestsPerCrawl` alone
        // can't enforce this — it counts every dispatch (including ones
        // we reject), and we deliberately gave it headroom.
        if (this.stats.pagesDiscovered >= this.options.maxPages) {
            return;
        }

        if (this.visitedUrls.has(normalizedUrl) || this.inFlightUrls.has(normalizedUrl)) {
            return;
        }

        this.inFlightUrls.add(normalizedUrl);

        // Tracks whether we reached a definitive outcome. Set to `true`
        // by every branch below that should NOT be retried; left `false`
        // when an exception bubbles out of the handler so Crawlee retries
        // and we get another shot at the page.
        let committed = false;

        try {
            try {
                await page.waitForLoadState("domcontentloaded", {
                    timeout: this.options.timeout,
                });
            } catch {
                // domcontentloaded timeout is rarely fatal — proceed and
                // let the settle wait below try.
            }

            // Wait for the SPA shell to actually render. Modern
            // React/Vue/Svelte apps boot in a microtask after the initial
            // bundle parses, so the DOM at `domcontentloaded` is just
            // `<div id="root"></div>` with no links. Without this settle
            // wait, link extraction below would see zero anchors on every
            // SPA — which is exactly the "only 1 page discovered" symptom.
            // `networkidle` (500ms of no network) is the canonical
            // hydrated signal. Capped because chatty apps with analytics
            // pings or websockets never reach true idle.
            try {
                const settleTimeout = Math.min(this.options.timeout, 10_000);
                await page.waitForLoadState("networkidle", { timeout: settleTimeout });
            } catch {
                // Page may have constant background activity; proceed anyway.
            }

            // Honor user-issued skip list before doing any detector work.
            if (this.skippedUrls.has(normalizedUrl) || this.skippedUrls.has(url)) {
                this.markBrokenLinks(url, normalizedUrl, "Skipped by user", "broken");
                committed = true;
                return;
            }

            // Run all blocker detectors in priority order.
            const blocker = await this.runDetectorPipeline(page, url, response ?? undefined);

            if (blocker) {
                const effectiveSeverity = this.ignoredCategories.has(blocker.category)
                    ? ("log" as const)
                    : blocker.severity;
                const persisted: Omit<DiscoveryBlocker, "id"> = {
                    ...blocker,
                    severity: effectiveSeverity,
                };
                const blockerId = this.siteDb.saveBlocker(persisted);
                this.stats.authBlockersFound++;

                // Dual-emit while consumers migrate. The legacy
                // `auth_blocked` event is only fired for `auth_required`
                // blockers so non-auth detectors don't accidentally
                // trigger old listeners.
                const blockerWithId: DiscoveryBlocker = {
                    ...persisted,
                    id: blockerId,
                };
                this.emit("blocker_detected", {
                    type: "blocker_detected",
                    data: { blocker: blockerWithId },
                    timestamp: Date.now(),
                });
                if (blocker.category === "auth_required") {
                    this.emit("auth_blocked", {
                        type: "auth_blocked",
                        data: { blocker: blockerWithId },
                        timestamp: Date.now(),
                    });
                }

                if (effectiveSeverity !== "pause") {
                    this.markBrokenLinks(url, normalizedUrl, "Blocker detected", "broken");
                    committed = true;
                    return;
                }

                // Once we've successfully crawled at least one page with
                // the current storage state, treat further auth blockers
                // as one-off protected URLs (skip them) rather than as
                // session-wide failures (pause + teardown). Captchas /
                // 5xx don't get magically cleared by a storage state, so
                // they always pause.
                const shouldPause =
                    blocker.category !== "auth_required"
                        ? true
                        : this.options.pauseOnAuth && !this.hasSeenAuthenticatedSuccess;

                if (!shouldPause) {
                    this.markBrokenLinks(
                        url,
                        normalizedUrl,
                        blocker.category === "auth_required" ? "Auth required" : "Blocker detected",
                        blocker.category === "auth_required" ? "auth_required" : "broken",
                    );
                    committed = true;
                    return;
                }

                // Pass blockedAtUrl into pause so it is re-inserted into
                // pendingRequests *before* queue_json is serialized — otherwise
                // the committed delete below would leave it out of the snapshot.
                await this.pause({ blockedAtUrl: url });
                committed = true;
                return;
            }

            if (response && response.status() >= 400) {
                const status = response.status();
                const linkStatus = status === 401 || status === 403 ? "auth_required" : "broken";
                this.markBrokenLinks(url, normalizedUrl, `HTTP ${status}`, linkStatus);
                committed = true;
                return;
            }

            // The URL Playwright actually landed on, post-redirects. May
            // differ from the requested URL via server-side 301/302,
            // client-side `<meta http-equiv="refresh">`, or JS
            // `location.assign(...)`.
            const resolvedUrl = response?.url() || url;
            const resolvedNormalized = this.normalizeUrl(resolvedUrl);
            const startOrigin = this.startOrigin;

            // Track login-shaped resolved URLs so the empty-crawl
            // diagnostic can suggest `raiken auth` even when no detector
            // fired (e.g. magic-link login pages with no password field,
            // or `raiken discover` pointed straight at /auth/login).
            if (looksLikeLoginUrl(resolvedUrl) && this.resolvedLoginShapedUrls.size < 5) {
                this.resolvedLoginShapedUrls.add(resolvedUrl);
            }

            // Off-origin redirect: the inbound link technically navigated
            // somewhere, but it's not part of *this* site. Verifying the
            // link without saving the destination keeps our page graph
            // origin-pure (otherwise we'd record `elsewhere.com`'s title
            // and links under our own origin's URL — confusing for the
            // user and noisy for downstream test generation).
            const resolvedOrigin = safeOrigin(resolvedUrl);
            if (startOrigin && resolvedOrigin && resolvedOrigin !== startOrigin) {
                this.verifyPendingLinks(url, normalizedUrl);
                this.emit("warning", {
                    type: "warning",
                    data: {
                        url,
                        message: `Followed off-origin redirect to ${resolvedUrl}; not crawling further.`,
                    },
                    timestamp: Date.now(),
                });
                committed = true;
                return;
            }

            this.verifyPendingLinks(resolvedUrl, resolvedNormalized);

            // Snapshot is best-effort: it's a heavy DOM serialization that
            // can OOM or time out on huge pages, and the page may close
            // mid-call during teardown. Rate-limit reports so a busted
            // page type doesn't flood the timeline.
            let snapshotJson: string | null = null;
            try {
                const snapshot = await page.locator("body").ariaSnapshot();
                snapshotJson = snapshot || null;
            } catch (err) {
                if (this.snapshotFailureReports < 5) {
                    this.snapshotFailureReports++;
                    const msg = err instanceof Error ? err.message : String(err);
                    this.emit("snapshot_failed", {
                        type: "snapshot_failed",
                        data: { url, message: msg.slice(0, 200) },
                        timestamp: Date.now(),
                    });
                }
            }

            // Structured form fields (label/type/selector per input). Best-effort
            // so a busted page never aborts the save. Fed to test generation so
            // specs reference real form controls instead of guessing them.
            const formsJson = await extractPageForms(page);

            // Title is also best-effort — Playwright throws "Target page,
            // context or browser has been closed" here when the page
            // navigates away mid-handler. Falling back to "" is strictly
            // better than aborting the whole save and losing the page.
            let title = "";
            try {
                title = await page.title();
            } catch {
                // Fall through with an empty title; downstream consumers
                // handle it gracefully.
            }

            // If the page redirected to a same-origin different URL, save
            // under the *resolved* URL so subsequent visits dedupe
            // correctly. The original URL's pending links were already
            // verified above.
            const saveUrl = resolvedUrl;
            const saveNormalized = resolvedNormalized;

            const now = Date.now();
            const existingPage = this.siteDb.getPage(saveUrl);

            if (existingPage) {
                // Refresh the captured content on revisit, not just visit
                // metadata — a page re-crawled after an auth handoff (or a
                // resumed session hitting the same URL twice) otherwise keeps
                // its stale pre-login snapshot/forms forever.
                this.siteDb.updatePageContent(saveUrl, { title, snapshotJson, formsJson });
            } else {
                this.siteDb.savePage({
                    projectPath: this.options.projectPath,
                    url: saveUrl,
                    normalizedUrl: saveNormalized,
                    title,
                    snapshotJson,
                    formsJson,
                    parentUrl: (request.userData["parentUrl"] as string) || null,
                    navigationAction: null,
                    depth,
                    discoveredAt: now,
                    lastVisitedAt: now,
                    visitCount: 1,
                });

                this.stats.pagesDiscovered++;

                // Confirms the loaded storage state actually unlocked the
                // app — gates the "downgrade further auth blockers to
                // skip" behavior above.
                if (this.playwrightStorageState) {
                    this.hasSeenAuthenticatedSuccess = true;
                }

                this.emit("page_discovered", {
                    type: "page_discovered",
                    data: {
                        page: { url: saveUrl, title, depth },
                    },
                    timestamp: now,
                });
            }

            // Mark the resolved URL as committed too so a same-page
            // redirect doesn't get re-crawled if a future link points at
            // the pre-redirect URL.
            if (saveNormalized !== normalizedUrl) {
                this.visitedUrls.add(saveNormalized);
            }

            if (!startOrigin) {
                committed = true;
                return;
            }

            // Atomic link extraction inside the page context. Single
            // round-trip, no stale element handles. We pull a richer set
            // than `a[href]` — anchors with `role="link"` (often used in
            // SPAs that hijack click) and elements with `data-href` cover
            // common cases that pure `a[href]` misses.
            const extracted = await this.extractLinks(page);

            // Same-origin URLs we should crawl next. Collected from the FULL
            // extracted set (a[href] + role=link + data-href) so SPA routes that
            // Crawlee's DOM-selector `enqueueLinks` misses still get visited.
            const enqueueCandidates: string[] = [];

            for (const item of extracted) {
                const cleanedHref = item.href.trim();
                if (
                    cleanedHref.length === 0 ||
                    cleanedHref.startsWith("#") ||
                    cleanedHref.startsWith("mailto:") ||
                    cleanedHref.startsWith("tel:") ||
                    cleanedHref.startsWith("javascript:")
                ) {
                    continue;
                }

                let absoluteUrl: string;
                try {
                    absoluteUrl = new URL(cleanedHref, saveUrl).toString();
                } catch {
                    continue;
                }

                const linkOrigin = safeOrigin(absoluteUrl);
                if (!linkOrigin || linkOrigin !== startOrigin) {
                    continue;
                }

                const selector = buildLinkSelector(
                    cleanedHref,
                    item.text.trim(),
                    item.dataTestId ?? null,
                    { tagName: item.tagName, role: item.role },
                );

                this.siteDb.saveLink({
                    projectPath: this.options.projectPath,
                    fromUrl: saveUrl,
                    toUrl: absoluteUrl,
                    selector,
                    linkText: item.text.trim() || null,
                    elementRole: item.role ?? null,
                    status: "pending",
                    errorMessage: null,
                    discoveredAt: now,
                    verifiedAt: null,
                });

                enqueueCandidates.push(absoluteUrl);
                this.stats.linksFound++;
            }

            // Enqueue the URLs we extracted ourselves rather than delegating to
            // Crawlee's DOM-selector `enqueueLinks`. `extractLinks` already
            // resolves `a[href]`, `[role="link"]` AND `[data-href]` (the last
            // two are common on SPAs that hijack navigation) — enqueueLinks with
            // a CSS selector would miss `data-href` and `role=link` without an
            // href entirely, so those routes were saved as links but never
            // crawled. We apply our own filtering (excluded patterns +
            // already-visited normalization + maxPages cap) and set `uniqueKey`
            // to our normalized URL so Crawlee dedupes on it (otherwise
            // `/x?a=1` and `/x?a=2` dispatch as distinct even when we'd reject
            // the second on entry — significant on query-paramed SPA links).
            const requests: Array<{
                url: string;
                uniqueKey: string;
                userData: { depth: number; parentUrl: string };
            }> = [];
            const seenKeys = new Set<string>();
            for (const candidate of enqueueCandidates) {
                if (this.shouldExclude(candidate)) continue;
                const norm = this.normalizeUrl(candidate);
                if (this.visitedUrls.has(norm) || this.inFlightUrls.has(norm)) continue;
                if (seenKeys.has(norm)) continue;
                if (this.stats.pagesDiscovered >= this.options.maxPages) break;
                seenKeys.add(norm);
                const userData = { depth: depth + 1, parentUrl: saveUrl };
                requests.push({ url: candidate, uniqueKey: norm, userData });
                this.pendingRequests.set(norm, { url: candidate, uniqueKey: norm, userData });
            }
            if (requests.length > 0 && this.requestQueue) {
                await this.requestQueue.addRequests(requests);
            }

            if (this.sessionId) {
                this.siteDb.updateSession(this.sessionId, {
                    pagesDiscovered: this.stats.pagesDiscovered,
                    linksFound: this.stats.linksFound,
                });
            }

            committed = true;
        } finally {
            this.inFlightUrls.delete(normalizedUrl);
            if (committed) {
                this.visitedUrls.add(normalizedUrl);
                // No longer pending once we've fully processed it. Left in the
                // map on failure so a resume retries it.
                this.pendingRequests.delete(normalizedUrl);
            }
            // If `committed` is false the URL is left out of `visitedUrls`
            // so Crawlee's retry layer can dispatch it again; the failed-
            // request handler will eventually catch terminal failures and
            // emit a `warning` for diagnostics.
        }
    }

    /**
     * Pull all candidate navigation elements from the page in a single
     * `evaluate()` call. Avoids the N+1 round-trips of iterating Locators
     * (each `getAttribute` is a CDP message), and avoids stale-element
     * handle errors when the SPA mutates the DOM mid-extraction.
     */
    private async extractLinks(page: Page): Promise<
        Array<{
            href: string;
            text: string;
            role: string | null;
            dataTestId: string | null;
            tagName: string | null;
        }>
    > {
        try {
            // SPA-aware extraction: plain anchors plus route-bearing custom
            // components (role=link without href, data-to/data-path buttons in
            // nav). Mirrors BrowserSession's richer selectors so discovery and
            // live agent exploration see the same graph.
            return await page.evaluate(() => {
                const ROUTE_ATTRS = [
                    "href",
                    "data-href",
                    "data-url",
                    "data-to",
                    "data-path",
                    "to",
                ] as const;
                const MAX = 250;

                const isLikelyRoute = (value: string): boolean => {
                    const v = value.trim();
                    if (!v) return false;
                    if (
                        v.startsWith("#") ||
                        v.startsWith("mailto:") ||
                        v.startsWith("tel:") ||
                        v.startsWith("javascript:") ||
                        v.startsWith("data:")
                    ) {
                        return false;
                    }
                    if (
                        /^(https?:)?\/\//i.test(v) ||
                        v.startsWith("/") ||
                        v.startsWith("./") ||
                        v.startsWith("../")
                    ) {
                        return true;
                    }
                    return /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]*)*$/.test(v) && v.includes("/");
                };

                const resolveHref = (el: Element): string => {
                    for (const name of ROUTE_ATTRS) {
                        const raw = el.getAttribute(name);
                        if (raw && isLikelyRoute(raw)) return raw.trim();
                    }
                    return "";
                };

                const isVisible = (el: HTMLElement): boolean => {
                    const style = window.getComputedStyle(el);
                    if (style.display === "none" || style.visibility === "hidden") return false;
                    if (style.opacity === "0") return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };

                const selectors = [
                    "a[href]",
                    "a[to]",
                    "[data-href]",
                    "[data-url]",
                    "[data-to]",
                    "[data-path]",
                    '[role="link"]',
                    "nav button[data-href], nav button[data-url], nav button[data-to], nav button[data-path]",
                    'nav [role="button"][data-href], nav [role="button"][data-to], nav [role="button"][data-path]',
                    'nav [role="tab"][data-href], nav [role="tab"][data-to], nav [role="tab"][data-path]',
                    'nav [role="menuitem"][data-href], nav [role="menuitem"][data-to], nav [role="menuitem"][data-path]',
                ];

                const out: Array<{
                    href: string;
                    text: string;
                    role: string | null;
                    dataTestId: string | null;
                    tagName: string | null;
                }> = [];
                const seen = new Set<Element>();
                const seenHrefs = new Set<string>();

                for (const sel of selectors) {
                    if (out.length >= MAX) break;
                    const nodes = document.querySelectorAll(sel);
                    for (const node of Array.from(nodes)) {
                        if (out.length >= MAX) break;
                        if (seen.has(node)) continue;
                        seen.add(node);
                        const el = node as HTMLElement;
                        if (!isVisible(el)) continue;
                        const href = resolveHref(el);
                        if (!href) continue;
                        if (seenHrefs.has(href)) continue;
                        seenHrefs.add(href);
                        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
                        out.push({
                            href,
                            text: text.slice(0, 200),
                            role: el.getAttribute("role"),
                            dataTestId: el.getAttribute("data-testid"),
                            tagName: el.tagName ? el.tagName.toLowerCase() : null,
                        });
                    }
                }
                return out;
            });
        } catch {
            // Page closed / context destroyed mid-extraction. Not fatal —
            // we'll still return the page's metadata; link discovery from
            // this hop is just lost.
            return [];
        }
    }

    /**
     * Get current discovery statistics.
     */
    getStats(): DiscoveryStats {
        this.stats.elapsedMs = Date.now() - this.stats.startedAt;
        return { ...this.stats };
    }

    /**
     * Detector pipeline. Delegates to `runBlockerPipeline`, which runs
     * each detector in priority order and returns the first match.
     *
     * Kept as a separate method so callers (tests, future detectors that
     * compose existing ones) can run it without going through Crawlee's
     * request handler.
     */
    private async runDetectorPipeline(
        page: Page,
        url: string,
        response: Response | undefined,
    ): Promise<DiscoveryBlocker | null> {
        return runBlockerPipeline(this.detectors, {
            projectPath: this.options.projectPath,
            url,
            page,
            response,
        });
    }

    /**
     * Check if a URL should be excluded. Patterns can be:
     *  - Plain substring (legacy: e.g. "/admin" matches any URL containing "/admin")
     *  - Glob (e.g. "/admin/**", "*.pdf") — only when the pattern contains "*"
     */
    private shouldExclude(url: string): boolean {
        for (const matcher of this.compiledExcludeMatchers) {
            if (matcher(url)) return true;
        }
        return false;
    }

    private normalizeUrl(url: string): string {
        return normalizeUrl(url, {
            preserveQueryParams: this.options.preserveQueryParams,
        });
    }

    private getOriginSafe(url: string): string | null {
        try {
            return new URL(url).origin;
        } catch {
            return null;
        }
    }

    /**
     * Reduce a Playwright/Crawlee navigation error to a one-line, user-
     * friendly reason. We swallow the stack and pull out the recognisable
     * Chrome NET error code (e.g. `NET::ERR_HTTP_RESPONSE_CODE_FAILURE`)
     * because the raw message is multi-paragraph and noisy.
     */
    private summariseFailure(error: Error | undefined, status: number | null): string {
        if (status && status >= 400) {
            return `HTTP ${status}`;
        }
        const raw = error?.message ?? "Unknown navigation failure";
        const netCode = raw.match(/net::ERR_[A-Z_0-9]+/i)?.[0];
        if (netCode) return netCode;
        if (/Timeout .* exceeded/i.test(raw)) return "Navigation timeout";
        if (/Target .* closed|Browser .* closed/i.test(raw)) return "Browser closed mid-navigation";
        if (/Maximum retry count exceeded/i.test(raw)) return "Retry exhausted";
        // Trim down multi-line Playwright errors so the dashboard timeline
        // stays readable.
        const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw;
        return firstLine.slice(0, 200);
    }

    /**
     * Compose the user-facing error for a crawl that completed without
     * discovering any pages. Includes whatever diagnostic context we
     * captured (failed requests, blockers detected) so the user knows
     * whether to (a) check the URL, (b) authenticate first, or (c) try a
     * non-headless browser for anti-bot-protected sites.
     */
    private buildEmptyCrawlError(): string {
        const parts: string[] = [`No pages discovered at ${this.options.startUrl}.`];

        if (this.failedRequests.length > 0) {
            // Group by reason so a single anti-bot block doesn't print 30 times.
            const byReason = new Map<string, number>();
            for (const f of this.failedRequests) {
                byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
            }
            const summary = Array.from(byReason.entries())
                .map(([reason, count]) => (count > 1 ? `${reason} (×${count})` : reason))
                .join("; ");
            parts.push(`${this.failedRequests.length} request(s) failed: ${summary}.`);
        }

        if (this.stats.authBlockersFound > 0) {
            parts.push(
                `${this.stats.authBlockersFound} blocker(s) were detected but downgraded to log-only — every page was gated. Try resolving the first blocker (e.g. \`raiken auth\` or the dashboard's "Open in browser" button) and re-running.`,
            );
        }

        // Residual auth-wall hint: if the start URL or any resolved URL
        // looked login-shaped but no detector fired (magic-link only,
        // OAuth-only, or a slow-hydrating SPA that never rendered the
        // password input), emit a specific actionable message instead of
        // the generic "page rendered nothing" fallback.
        const loginShapedSamples = new Set<string>();
        if (looksLikeLoginUrl(this.options.startUrl)) {
            loginShapedSamples.add(this.options.startUrl);
        }
        for (const url of this.resolvedLoginShapedUrls) {
            loginShapedSamples.add(url);
        }
        const sawLoginShapedUrl = loginShapedSamples.size > 0;

        if (
            this.failedRequests.length === 0 &&
            this.stats.authBlockersFound === 0 &&
            !this.handlerInvoked
        ) {
            // Silent-drain symptom — see `handlerInvoked` field doc.
            // The crawler ran but never even called the request handler,
            // which means Crawlee dropped every dispatched request before
            // it reached us (deduped against a stale "URL already handled"
            // log carried over from a prior session). The unique-queue-name
            // fix in `start()` should prevent this; if you're seeing it,
            // restart the Raiken server to clear in-process Crawlee state.
            parts.push(
                `The crawler completed without dispatching any requests — likely a stale Crawlee request-queue cache from a previous run on the same URL. Restart \`raiken start\` to clear the in-process cache, or report this if it persists across restarts.`,
            );
        } else if (
            this.failedRequests.length === 0 &&
            this.stats.authBlockersFound === 0 &&
            sawLoginShapedUrl
        ) {
            const sample = Array.from(loginShapedSamples)[0];
            parts.push(
                `The crawl resolved to a login-shaped URL (${sample}) but no detector fired — this often means a magic-link or OAuth-only login flow that hides the standard \`<input type="password">\` field. Run \`raiken auth --url ${this.options.startUrl}\` to log in interactively, or pass \`--skip-auth\` to skip protected routes.`,
            );
        } else if (this.failedRequests.length === 0 && this.stats.authBlockersFound === 0) {
            parts.push(
                "Either the URL didn't return HTML, the page rendered nothing the crawler could index, or the site detected the headless browser. Try running `raiken auth --url <startUrl>` first to confirm the page is reachable, or test the URL manually.",
            );
        } else if (this.failedRequests.some((f) => /timeout|net::|closed/i.test(f.reason))) {
            parts.push(
                "Sites with strong anti-bot protection (e.g. social networks, paywalled news) often refuse headless Chromium. Discovery currently runs headless only.",
            );
        }

        return parts.join(" ");
    }

    private loadStorageState(): void {
        if (!this.options.storageStatePath) {
            this.playwrightStorageState = null;
            return;
        }
        try {
            if (!fs.existsSync(this.options.storageStatePath)) {
                if (!this.storageStateWarningEmitted) {
                    console.warn(`Storage state not found at ${this.options.storageStatePath}`);
                    this.storageStateWarningEmitted = true;
                }
                this.playwrightStorageState = null;
                return;
            }
            const raw = fs.readFileSync(this.options.storageStatePath, "utf-8");
            const parsed = JSON.parse(raw) as StorageStateInput;
            this.playwrightStorageState = sanitizeStorageState(parsed);
        } catch {
            if (!this.storageStateWarningEmitted) {
                console.warn("Failed to load storage state for discovery");
                this.storageStateWarningEmitted = true;
            }
            this.playwrightStorageState = null;
        }
    }

    private verifyPendingLinks(url: string, normalizedUrl: string): void {
        const candidates = new Set<string>([url, normalizedUrl]);
        if (url.endsWith("/")) {
            candidates.add(url.slice(0, -1));
        } else {
            candidates.add(`${url}/`);
        }

        for (const candidate of candidates) {
            const pendingLinks = this.siteDb.getPendingLinksTo(candidate);
            for (const link of pendingLinks) {
                this.siteDb.updateLinkStatus(link.fromUrl, link.toUrl, "verified");
            }
        }
    }

    private markBrokenLinks(
        url: string,
        normalizedUrl: string,
        errorMessage: string,
        status: "broken" | "auth_required" = "broken",
    ): void {
        const pendingLinks = this.siteDb.getPendingLinksTo(url);
        for (const link of pendingLinks) {
            this.siteDb.updateLinkStatus(link.fromUrl, link.toUrl, status, errorMessage);
        }

        if (normalizedUrl !== url) {
            const normalizedLinks = this.siteDb.getPendingLinksTo(normalizedUrl);
            for (const link of normalizedLinks) {
                this.siteDb.updateLinkStatus(link.fromUrl, link.toUrl, status, errorMessage);
            }
        }
    }

    private async persistQueueState(): Promise<void> {
        if (!this.sessionId) {
            return;
        }

        try {
            // Crawlee runs with `persistStorage: false`, so its request queue
            // lives only in memory and never writes to disk — reading
            // `request_queues/*` (as this used to) always found nothing and
            // resume silently lost every pending URL. We instead persist our
            // own `pendingRequests` map, which is the authoritative record of
            // enqueued-but-unvisited URLs, so a resume re-seeds ALL of them.
            const serialized = Array.from(this.pendingRequests.values()).map((request) => ({
                url: request.url,
                uniqueKey: request.uniqueKey,
                userData: request.userData,
            }));

            this.siteDb.updateSession(this.sessionId, {
                queueJson: JSON.stringify(serialized),
            });
        } catch {
            // Ignore queue persistence errors
        }
    }

    /**
     * Clean up resources.
     *
     * `crawler.teardown()` is wrapped because Crawlee dereferences
     * `this.sessionPool` unconditionally — but `sessionPool` is only
     * created once `crawler.run()` has progressed past its setup phase.
     * If `start()` threw early (bad config, port conflict, missing
     * Chromium, ...) or if `run()` exited so fast that teardown is
     * called twice, the unguarded call throws `TypeError: Cannot read
     * properties of undefined (reading 'teardown')` and that bubbles up
     * as an unhandled rejection — crashing the entire CLI server.
     */
    async close(): Promise<void> {
        this.disarmWallClockTimer();
        if (this.crawler) {
            try {
                await this.crawler.teardown();
            } catch (err) {
                // Swallow — best-effort cleanup. We surface it via a
                // warning event so it's still visible in the timeline.
                this.emit("warning", {
                    type: "warning",
                    data: {
                        url: this.options.startUrl,
                        message: `Crawler teardown failed (likely never fully initialized): ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    },
                    timestamp: Date.now(),
                });
            }
        }
        // Drop the per-instance queue so its cache entry is freed and a
        // future `RequestQueue.open(<sameName>)` won't return our stale
        // "URLs already handled" log. Belt-and-braces with the unique
        // queue name — the name alone prevents collisions across runs,
        // but the drop releases memory once the run is done.
        if (this.requestQueue) {
            try {
                await this.requestQueue.drop();
            } catch {
                // Best-effort: dropping a queue that was never fully
                // initialized (e.g. SiteDiscovery threw before
                // RequestQueue.open completed) raises an unrelated
                // error inside Crawlee. Ignored — the unique queue
                // name already guarantees the next run is clean.
            }
            this.requestQueue = null;
        }
        this.db.close();
    }
}

/**
 * Convert a single exclude pattern into a matcher function.
 *
 *   - Patterns without "*" → legacy substring match (backward-compatible).
 *   - Patterns with "*"    → glob: "*" matches any chars except "/", "**"
 *                              matches any chars including "/".
 *
 * Bad regex compilation falls back to substring so a malformed entry can never
 * crash the crawl.
 */
/**
 * Coerce raw storage-state JSON into the exact shape Playwright accepts at
 * `browser.newContext({ storageState })`. Real-world auth-state.json files
 * — especially those produced by older Chromium versions or third-party
 * exporters — frequently contain cookies with `sameSite: null` or non-
 * canonical values, which Playwright rejects, silently dropping the entire
 * session. Coerce to "Lax" as a safe default and strip unknown fields.
 */
function sanitizeStorageState(state: StorageStateInput): {
    cookies: StorageStateCookie[];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
    const validSameSite = new Set(["Strict", "Lax", "None"]);
    const cookies: StorageStateCookie[] = [];
    for (const raw of Array.isArray(state.cookies) ? state.cookies : []) {
        if (
            typeof raw !== "object" ||
            raw === null ||
            typeof (raw as Record<string, unknown>)["name"] !== "string" ||
            typeof (raw as Record<string, unknown>)["value"] !== "string"
        ) {
            continue;
        }
        const r = raw as Record<string, unknown>;
        const sameSiteRaw = r["sameSite"];
        const sameSite: "Strict" | "Lax" | "None" =
            typeof sameSiteRaw === "string" && validSameSite.has(sameSiteRaw)
                ? (sameSiteRaw as "Strict" | "Lax" | "None")
                : "Lax";
        cookies.push({
            name: r["name"] as string,
            value: r["value"] as string,
            domain: typeof r["domain"] === "string" ? (r["domain"] as string) : undefined,
            path: typeof r["path"] === "string" ? (r["path"] as string) : undefined,
            url: typeof r["url"] === "string" ? (r["url"] as string) : undefined,
            expires: typeof r["expires"] === "number" ? (r["expires"] as number) : undefined,
            httpOnly: typeof r["httpOnly"] === "boolean" ? (r["httpOnly"] as boolean) : undefined,
            secure: typeof r["secure"] === "boolean" ? (r["secure"] as boolean) : undefined,
            sameSite,
        });
    }

    const origins: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
    }> = [];
    for (const raw of Array.isArray(state.origins) ? state.origins : []) {
        if (typeof raw?.origin !== "string") continue;
        const localStorage: Array<{ name: string; value: string }> = [];
        for (const item of Array.isArray(raw.localStorage) ? raw.localStorage : []) {
            if (typeof item?.name === "string" && typeof item?.value === "string") {
                localStorage.push({ name: item.name, value: item.value });
            }
        }
        origins.push({ origin: raw.origin, localStorage });
    }

    return { cookies, origins };
}

function compileExcludeMatcher(pattern: string): (url: string) => boolean {
    if (!pattern) {
        return () => false;
    }
    if (!pattern.includes("*")) {
        return (url) => url.includes(pattern);
    }
    try {
        // Two-pass replacement using a sentinel that can't appear in URLs.
        const DOUBLESTAR_SENTINEL = "__RAIKEN_GLOBSTAR__";
        const re = pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, DOUBLESTAR_SENTINEL)
            .replace(/\*/g, "[^/]*")
            .replace(new RegExp(DOUBLESTAR_SENTINEL, "g"), ".*");
        const compiled = new RegExp(re);
        return (url) => compiled.test(url);
    } catch {
        return (url) => url.includes(pattern);
    }
}
