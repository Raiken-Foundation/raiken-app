import type { PlaywrightCrawlingContext, RequestQueue } from "crawlee";
import type { Page, Response } from "playwright";
import type { SiteKnowledgeDB } from "../db";
import { type BlockerDetector, runBlockerPipeline } from "../detectors";
import { looksLikeLoginUrl, looksLikeLogoutUrl } from "../detectors/auth";
import { isSyntheticProxyStatus } from "../detectors/manual-fallback";
import { buildLinkSelector, safeOrigin } from "../link-utils";
import type { BlockerCategory, DiscoveryBlocker, DiscoveryOptions, DiscoveryStats } from "../types";
import { shouldExcludeUrl } from "./exclude-patterns";
import { extractPageForms } from "./form-extractor";
import { extractLinksFromPage } from "./link-extraction";
import { markBrokenLinks, verifyPendingLinks } from "./link-verification";
import type { CrawlerEventPayload, PendingRequest, PlaywrightStorageState } from "./types";

export type PauseFromHandler = (options: {
    blockedAtUrl?: string | null;
    calledFromHandler?: boolean;
    reason?: "wall_clock_cap";
}) => Promise<void>;

export type CrawlPageProcessorDeps = {
    options: Required<DiscoveryOptions>;
    stats: DiscoveryStats;
    siteDb: SiteKnowledgeDB;
    getSessionId: () => number | null;
    getRequestQueue: () => RequestQueue | null;
    getStartOrigin: () => string | null;
    visitedUrls: Set<string>;
    inFlightUrls: Set<string>;
    /**
     * Normalized URLs committed (saved or refreshed) during THIS run.
     * Drives the unique-page count in `stats.pagesDiscovered`: a page
     * committed twice in one run (e.g. reached via a redirect, then
     * crawled directly) must count once so the run summary agrees with
     * the persisted row count.
     */
    committedUrls: Set<string>;
    pendingRequests: Map<string, PendingRequest>;
    skippedUrls: Set<string>;
    ignoredCategories: Set<BlockerCategory>;
    detectors: BlockerDetector[];
    playwrightStorageState: PlaywrightStorageState | null;
    hasSeenAuthenticatedSuccess: { current: boolean };
    resolvedLoginShapedUrls: Set<string>;
    snapshotFailureReports: { count: number };
    handlerInvoked: { current: boolean };
    isPaused: () => boolean;
    excludeMatchers: Array<(url: string) => boolean>;
    normalizeUrl: (url: string) => string;
    pause: PauseFromHandler;
    emit: (event: CrawlerEventPayload) => boolean;
    /** Record a navigation-level failure (drives the empty-crawl diagnosis). */
    recordFailure: (url: string, reason: string, status: number | null) => void;
};

export function createCrawlPageProcessor(deps: CrawlPageProcessorDeps) {
    return async function handleRequest(context: PlaywrightCrawlingContext): Promise<void> {
        const { page, request, response } = context;
        const url = request.url;
        const depth = (request.userData["depth"] as number) || 0;

        deps.handlerInvoked.current = true;

        if (deps.isPaused()) {
            return;
        }

        deps.stats.currentUrl = url;
        deps.stats.currentDepth = Math.max(deps.stats.currentDepth, depth);

        const normalizedUrl = deps.normalizeUrl(url);

        // These URLs will never be crawled, so drop them from the resume queue.
        // Left pending they are re-enqueued and re-navigated on every resume
        // while always taking the same early return.
        const discard = () => deps.pendingRequests.delete(normalizedUrl);

        if (depth > deps.options.maxDepth) {
            discard();
            return;
        }

        if (shouldExcludeUrl(url, deps.excludeMatchers)) {
            discard();
            return;
        }

        // Budget exhausted: this URL stays pending because it is genuinely
        // undone work that a resume with a larger budget should pick up.
        if (deps.stats.pagesDiscovered >= deps.options.maxPages) {
            return;
        }

        if (deps.visitedUrls.has(normalizedUrl) || deps.inFlightUrls.has(normalizedUrl)) {
            discard();
            return;
        }

        deps.inFlightUrls.add(normalizedUrl);

        let committed = false;
        /** Login form captured without a session — save it, do not descend. */
        let stopDescendingAfterLoginCapture = false;

        try {
            try {
                await page.waitForLoadState("domcontentloaded", {
                    timeout: deps.options.timeout,
                });
            } catch {
                // domcontentloaded timeout is rarely fatal.
            }

            try {
                const settleTimeout = Math.min(deps.options.timeout, 10_000);
                await page.waitForLoadState("networkidle", { timeout: settleTimeout });
            } catch {
                // Page may have constant background activity; proceed anyway.
            }

            if (deps.skippedUrls.has(normalizedUrl) || deps.skippedUrls.has(url)) {
                markBrokenLinks(deps.siteDb, url, normalizedUrl, "Skipped by user", "broken");
                committed = true;
                return;
            }

            const blocker = await runBlockerPipeline(
                deps.detectors,
                {
                    projectPath: deps.options.projectPath,
                    url,
                    page,
                    response: response ?? undefined,
                },
                { skipCategories: deps.ignoredCategories },
            );

            if (blocker) {
                // A login-SHAPED URL is the form cover/repair need for cold
                // starts — always capture it (downgrade to informational) so
                // `--skip-auth` does not leave knowledge empty. Real walls are
                // unaffected: auth:http_status means the server rejected the
                // session, and auth:login_redirect only fires when a non-login
                // URL bounced to /login (so looksLikeLoginUrl(url) is false).
                // With a session loaded we also keep crawling past the form;
                // without one we still save the snapshot then stop descending
                // via the normal link budget (no protected content enqueue).
                const loginShapedPage =
                    blocker.category === "auth_required" &&
                    blocker.detectorId !== "auth:http_status" &&
                    looksLikeLoginUrl(url);
                if (loginShapedPage && !deps.playwrightStorageState) {
                    stopDescendingAfterLoginCapture = true;
                }
                const effectiveSeverity =
                    deps.ignoredCategories.has(blocker.category) || loginShapedPage
                        ? ("log" as const)
                        : blocker.severity;
                const persisted: Omit<DiscoveryBlocker, "id"> = {
                    ...blocker,
                    severity: effectiveSeverity,
                };
                const blockerId = deps.siteDb.saveBlocker(persisted);
                deps.stats.authBlockersFound++;

                const blockerWithId: DiscoveryBlocker = {
                    ...persisted,
                    id: blockerId,
                };
                deps.emit({
                    type: "blocker_detected",
                    data: { blocker: blockerWithId },
                    timestamp: Date.now(),
                });
                if (blocker.category === "auth_required" && !loginShapedPage) {
                    deps.emit({
                        type: "auth_blocked",
                        data: { blocker: blockerWithId },
                        timestamp: Date.now(),
                    });
                }

                if (effectiveSeverity === "skip") {
                    markBrokenLinks(deps.siteDb, url, normalizedUrl, "Blocker detected", "broken");
                    committed = true;
                    return;
                }

                if (effectiveSeverity === "pause") {
                    const shouldPause =
                        blocker.category !== "auth_required"
                            ? true
                            : deps.options.pauseOnAuth && !deps.hasSeenAuthenticatedSuccess.current;

                    if (!shouldPause) {
                        // Protected content behind auth with --skip-auth: do
                        // not save a blank/redirect shell as if it were a page.
                        markBrokenLinks(
                            deps.siteDb,
                            url,
                            normalizedUrl,
                            blocker.category === "auth_required"
                                ? "Auth required"
                                : "Blocker detected",
                            blocker.category === "auth_required" ? "auth_required" : "broken",
                        );
                        committed = true;
                        return;
                    }

                    await deps.pause({ blockedAtUrl: url, calledFromHandler: true });
                    committed = true;
                    return;
                }
            }

            if (response && response.status() >= 400) {
                const status = response.status();
                // Synthetic 59x: a proxy fabricated this — the origin never
                // answered. The links aren't "broken" and there is no page to
                // blame; record it as a navigation failure so the empty-crawl
                // diagnosis reports a reachability problem.
                if (isSyntheticProxyStatus(status)) {
                    const statusText = response.statusText();
                    deps.recordFailure(
                        url,
                        `HTTP ${status}${statusText ? ` (${statusText})` : ""} — upstream connection failed`,
                        status,
                    );
                    committed = true;
                    return;
                }
                const linkStatus = status === 401 || status === 403 ? "auth_required" : "broken";
                markBrokenLinks(deps.siteDb, url, normalizedUrl, `HTTP ${status}`, linkStatus);
                committed = true;
                return;
            }

            const resolvedUrl = response?.url() || url;
            const resolvedNormalized = deps.normalizeUrl(resolvedUrl);
            const startOrigin = deps.getStartOrigin();

            if (looksLikeLoginUrl(resolvedUrl) && deps.resolvedLoginShapedUrls.size < 5) {
                deps.resolvedLoginShapedUrls.add(resolvedUrl);
            }

            const resolvedOrigin = safeOrigin(resolvedUrl);
            if (startOrigin && resolvedOrigin && resolvedOrigin !== startOrigin) {
                verifyPendingLinks(deps.siteDb, url, normalizedUrl);
                deps.emit({
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

            verifyPendingLinks(deps.siteDb, resolvedUrl, resolvedNormalized);

            let snapshotJson: string | null = null;
            try {
                const snapshot = await page.locator("body").ariaSnapshot();
                snapshotJson = snapshot || null;
            } catch (err) {
                if (deps.snapshotFailureReports.count < 5) {
                    deps.snapshotFailureReports.count++;
                    const msg = err instanceof Error ? err.message : String(err);
                    deps.emit({
                        type: "snapshot_failed",
                        data: { url, message: msg.slice(0, 200) },
                        timestamp: Date.now(),
                    });
                }
            }

            const formsJson = await extractPageForms(page);

            let title = "";
            try {
                title = await page.title();
            } catch {
                // Fall through with an empty title.
            }

            const saveUrl = resolvedUrl;
            const saveNormalized = resolvedNormalized;

            // Re-check the budget immediately before committing. The check at
            // the top of the handler is separated from this point by many
            // awaits, so with maxConcurrency > 1 every in-flight worker can
            // pass it and overshoot the documented cap.
            if (deps.stats.pagesDiscovered >= deps.options.maxPages) {
                return;
            }

            const now = Date.now();
            const existingPage = deps.siteDb.getPage(saveUrl);
            // The loaded state, not the configured path: an expired or
            // unreadable auth-state.json leaves this null, and the pages we
            // capture with it really are signed-out.
            const capturedAuthenticated = Boolean(deps.playwrightStorageState);

            if (existingPage) {
                deps.siteDb.updatePageContent(saveUrl, {
                    title,
                    snapshotJson,
                    formsJson,
                    capturedAuthenticated,
                });
            } else {
                deps.siteDb.savePage({
                    projectPath: deps.options.projectPath,
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
                    capturedAuthenticated,
                });
            }

            // Count each page once per run. The same page can be committed
            // twice in one run (redirect target crawled directly later, or a
            // refresh after a knowledge clear); without this the run summary
            // inflates past the persisted row count. A page refreshed from a
            // PREVIOUS run still counts — it was genuinely processed this run
            // and is what keeps a refresh-only resume out of the empty-crawl
            // error path.
            if (!deps.committedUrls.has(saveNormalized)) {
                deps.committedUrls.add(saveNormalized);
                deps.stats.pagesDiscovered++;
            }

            if (deps.playwrightStorageState) {
                deps.hasSeenAuthenticatedSuccess.current = true;
            }

            deps.emit({
                type: "page_discovered",
                data: {
                    page: { url: saveUrl, title, depth },
                    refreshed: Boolean(existingPage),
                },
                timestamp: now,
            });

            if (saveNormalized !== normalizedUrl) {
                deps.visitedUrls.add(saveNormalized);
            }

            if (!startOrigin) {
                committed = true;
                return;
            }

            // Unauthenticated login capture: keep the form in knowledge, but do
            // not schedule protected routes the crawl cannot open without auth.
            if (stopDescendingAfterLoginCapture) {
                committed = true;
                return;
            }

            const extracted = await extractLinksFromPage(page);
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

                const inserted = deps.siteDb.saveLink({
                    projectPath: deps.options.projectPath,
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
                // saveLink is INSERT OR IGNORE keyed on (from, to, selector):
                // only a genuinely new edge grows the persisted count, so the
                // run summary and `discover --status` read the same number.
                if (inserted > 0) {
                    deps.stats.linksFound++;
                    // A link whose target already committed is verified on the
                    // spot — commit-time verification only reaches links saved
                    // *before* their target, so nav-style links back to earlier
                    // pages would otherwise stay "pending" forever.
                    if (
                        deps.visitedUrls.has(deps.normalizeUrl(absoluteUrl)) ||
                        deps.siteDb.getPage(absoluteUrl)
                    ) {
                        deps.siteDb.updateLinkStatus(saveUrl, absoluteUrl, "verified");
                    }
                }
            }

            const requests: Array<{
                url: string;
                uniqueKey: string;
                userData: { depth: number; parentUrl: string };
            }> = [];
            const seenKeys = new Set<string>();
            const childDepth = depth + 1;
            // Enqueueing past maxDepth only creates requests the handler is
            // guaranteed to discard, after paying for a real navigation.
            for (const candidate of childDepth > deps.options.maxDepth ? [] : enqueueCandidates) {
                if (shouldExcludeUrl(candidate, deps.excludeMatchers)) continue;
                // Never navigate logout-shaped URLs while a session is
                // loaded — the navigation would destroy the very session the
                // crawl is running on. The link itself was recorded above,
                // so the discovered structure is unaffected.
                if (deps.playwrightStorageState && looksLikeLogoutUrl(candidate)) continue;
                const norm = deps.normalizeUrl(candidate);
                if (deps.visitedUrls.has(norm) || deps.inFlightUrls.has(norm)) continue;
                if (seenKeys.has(norm)) continue;
                if (deps.stats.pagesDiscovered >= deps.options.maxPages) break;
                seenKeys.add(norm);
                const userData = { depth: childDepth, parentUrl: saveUrl };
                requests.push({ url: candidate, uniqueKey: norm, userData });
                deps.pendingRequests.set(norm, { url: candidate, uniqueKey: norm, userData });
            }
            const requestQueue = deps.getRequestQueue();
            if (requests.length > 0 && requestQueue) {
                await requestQueue.addRequests(requests);
            }

            const sessionId = deps.getSessionId();
            if (sessionId) {
                deps.siteDb.updateSession(sessionId, {
                    pagesDiscovered: deps.stats.pagesDiscovered,
                    linksFound: deps.stats.linksFound,
                });
            }

            committed = true;
        } finally {
            deps.inFlightUrls.delete(normalizedUrl);
            if (committed) {
                deps.visitedUrls.add(normalizedUrl);
                deps.pendingRequests.delete(normalizedUrl);
            }
        }
    };
}

/** Exposed for contract tests that exercise the detector pipeline without Crawlee. */
export async function runDetectorPipelineForPage(
    detectors: BlockerDetector[],
    page: Page,
    url: string,
    projectPath: string,
    response: Response | undefined,
    ignoredCategories: Set<BlockerCategory>,
): Promise<DiscoveryBlocker | null> {
    return runBlockerPipeline(
        detectors,
        { projectPath, url, page, response },
        { skipCategories: ignoredCategories },
    );
}
