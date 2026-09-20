/**
 * Site Discovery Crawler
 *
 * Autonomous crawler that discovers web application structure using Crawlee.
 * Integrates with AuthDetector and persists results to database.
 */

import { EventEmitter } from "node:events";
import { type PlaywrightCrawler, RequestQueue } from "crawlee";
import { resolveUsableAuthStorageStatePath } from "../config/auth-state";
import { CodeGraphDB } from "../database/db";
import {
    CheckpointScheduler,
    waitForCrawlerConcurrencyBelow,
} from "./crawler/checkpoint-scheduler";
import { compileExcludeMatcher } from "./crawler/exclude-patterns";
import { verifyLinksToCrawledPages } from "./crawler/link-verification";
import { releaseProcessWideCrawl, tryAcquireProcessWideCrawl } from "./crawler/process-wide-lock";
import { createCrawlPageProcessor } from "./crawler/request-handler";
import {
    buildEmptyCrawlError,
    buildPlaywrightCrawler,
    installFreshCrawleeStorage,
} from "./crawler/runtime-setup";
import { loadPlaywrightStorageState } from "./crawler/storage-state";
import type { FailedRequestRecord, PendingRequest, QueuedRequestSeed } from "./crawler/types";
import { SiteKnowledgeDB } from "./db";
import { createAuthDetector, createManualFallbackDetector } from "./detectors";
import { looksLikeLogoutUrl } from "./detectors/auth";
import { formatDiscoveryError } from "./discovery-error";
import { mergeBlockedUrlIntoQueue } from "./link-utils";
import { acquireDiscoveryLock, type DiscoveryLockHandle } from "./project-lock";
import type { BlockerCategory, DiscoveryOptions, DiscoveryStats } from "./types";
import { normalizeUrl } from "./url-utils";

export class SiteDiscovery extends EventEmitter {
    private crawler: PlaywrightCrawler | null = null;
    private db: CodeGraphDB;
    private siteDb: SiteKnowledgeDB;
    private detectors = [createManualFallbackDetector(), createAuthDetector()];
    private options: Required<DiscoveryOptions>;
    private sessionId: number | null = null;
    private stats: DiscoveryStats;
    private visitedUrls = new Set<string>();
    private isPaused = false;
    private startOrigin: string | null = null;
    private discoveryLock: DiscoveryLockHandle | null = null;
    private checkpointFailureWarned = false;
    private requestQueue: RequestQueue | null = null;
    private readonly queueName: string;
    private queuedRequests: QueuedRequestSeed[] | null = null;
    private pendingRequests = new Map<string, PendingRequest>();
    private playwrightStorageState: import("./crawler/types").PlaywrightStorageState | null = null;
    private storageStateWarningEmitted = false;
    private hasSeenAuthenticatedSuccess = { current: false };
    private aborted = false;
    private inFlightRun: Promise<void> | null = null;
    private closePromise: Promise<void> | null = null;
    private snapshotFailureReports = { count: 0 };
    private compiledExcludeMatchers: Array<(url: string) => boolean> = [];
    private skippedUrls = new Set<string>();
    private ignoredCategories = new Set<BlockerCategory>();
    private inFlightUrls = new Set<string>();
    private failedRequests: FailedRequestRecord[] = [];
    private resolvedLoginShapedUrls = new Set<string>();
    private committedUrls = new Set<string>();
    private handlerInvoked = { current: false };
    private checkpointScheduler: CheckpointScheduler;

    constructor(options: DiscoveryOptions, discoveryLock?: DiscoveryLockHandle) {
        super();
        this.discoveryLock = discoveryLock ?? null;

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
            settleQuietMs: options.settleQuietMs ?? 400,
            settleMaxMs: options.settleMaxMs ?? 3000,
        };

        this.compiledExcludeMatchers = this.options.excludePatterns.map(compileExcludeMatcher);
        this.queueName = `raiken-discovery-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;

        this.db = new CodeGraphDB(this.options.projectPath);
        this.siteDb = new SiteKnowledgeDB(
            this.db.getRawDatabase(),
            this.options.projectPath,
            this.options.preserveQueryParams,
        );

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

        this.checkpointScheduler = new CheckpointScheduler({
            sessionId: () => this.sessionId,
            pendingRequests: this.pendingRequests,
            siteDb: this.siteDb,
            startUrl: this.options.startUrl,
            emit: (event) => this.emit(event.type, event),
            isCheckpointFailureWarned: () => this.checkpointFailureWarned,
            markCheckpointFailureWarned: () => {
                this.checkpointFailureWarned = true;
            },
        });
    }

    async start(): Promise<void> {
        tryAcquireProcessWideCrawl(this);
        const run = this.runToCompletion();
        // `close()` waits on this before releasing the process-wide lock, so a
        // successor crawl can never swap Crawlee's global storage while this
        // run is still unwinding. The caller keeps the original promise, so
        // swallowing here does not hide the failure from them.
        this.inFlightRun = run.catch(() => undefined);
        return run;
    }

    private async runToCompletion(): Promise<void> {
        try {
            this.discoveryLock ??= await acquireDiscoveryLock(this.options.projectPath);
            installFreshCrawleeStorage(this.options.projectPath);

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
            await this.seedRequestQueue();

            this.crawler = buildPlaywrightCrawler({
                projectPath: this.options.projectPath,
                maxPages: this.options.maxPages,
                maxConcurrency: this.options.maxConcurrency,
                timeout: this.options.timeout,
                requestQueue: this.requestQueue,
                storageState: this.playwrightStorageState,
                onFailedRequest: ({ url, reason, status }) =>
                    this.recordFailedRequest({ url, reason, status }),
            });

            const handleRequest = createCrawlPageProcessor({
                options: this.options,
                stats: this.stats,
                siteDb: this.siteDb,
                getSessionId: () => this.sessionId,
                getRequestQueue: () => this.requestQueue,
                getStartOrigin: () => this.startOrigin,
                visitedUrls: this.visitedUrls,
                inFlightUrls: this.inFlightUrls,
                committedUrls: this.committedUrls,
                pendingRequests: this.pendingRequests,
                skippedUrls: this.skippedUrls,
                ignoredCategories: this.ignoredCategories,
                detectors: this.detectors,
                playwrightStorageState: this.playwrightStorageState,
                hasSeenAuthenticatedSuccess: this.hasSeenAuthenticatedSuccess,
                resolvedLoginShapedUrls: this.resolvedLoginShapedUrls,
                snapshotFailureReports: this.snapshotFailureReports,
                handlerInvoked: this.handlerInvoked,
                isPaused: () => this.isPaused,
                excludeMatchers: this.compiledExcludeMatchers,
                normalizeUrl: (url) => this.normalizeUrl(url),
                pause: (opts) => this.pause(opts),
                emit: (event) => this.emit(event.type, event),
                recordFailure: (url, reason, status) =>
                    this.recordFailedRequest({ url, reason, status }),
            });

            this.crawler.router.addDefaultHandler(handleRequest);

            const startUrls = this.computeStartUrls();
            this.trackSeedUrls(startUrls);

            if (this.options.continueSession) {
                const handled = await this.handleEmptyResumeQueue(startUrls);
                if (handled) return;
            }

            this.checkpointScheduler.armWallClockTimer(this.options.maxRunTimeMs, () => {
                void this.pause({ reason: "wall_clock_cap" }).catch(() => {});
            });
            this.checkpointScheduler.armCheckpointTimer();

            try {
                await this.crawler.run(startUrls);
            } finally {
                this.checkpointScheduler.disarmAll();
            }

            if (this.isPaused) {
                this.stats.elapsedMs = Date.now() - this.stats.startedAt;
                return;
            }

            if (this.aborted) {
                await this.finalizeSession("completed", { reason: "aborted" });
                return;
            }

            if (this.stats.pagesDiscovered === 0) {
                const message = buildEmptyCrawlError({
                    startUrl: this.options.startUrl,
                    failedRequests: this.failedRequests,
                    authBlockersFound: this.stats.authBlockersFound,
                    handlerInvoked: this.handlerInvoked.current,
                    resolvedLoginShapedUrls: this.resolvedLoginShapedUrls,
                });
                this.stats.status = "failed";
                if (this.sessionId) {
                    this.siteDb.updateSession(this.sessionId, {
                        status: "failed",
                        completedAt: Date.now(),
                        blockedAtUrl: null,
                    });
                }
                throw new Error(message);
            }

            await this.finalizeSession("completed");
        } catch (error) {
            this.checkpointScheduler.disarmAll();
            this.stats.status = "failed";
            // Persist the failure too — otherwise the session row stays
            // "running" until the next hydrate sweeps it, and `--continue`
            // would offer to resume a dead run.
            if (this.sessionId) {
                try {
                    this.siteDb.updateSession(this.sessionId, {
                        status: "failed",
                        completedAt: Date.now(),
                        blockedAtUrl: null,
                    });
                } catch {
                    // The DB may be the cause of the failure — nothing more to do.
                }
            }
            releaseProcessWideCrawl(this);
            await this.releaseDiscoveryLock();
            const surfacedError = new Error(formatDiscoveryError(error), { cause: error });
            this.emit("error", {
                type: "error",
                data: { error: surfacedError },
                timestamp: Date.now(),
            });
            throw surfacedError;
        }
    }

    private recordFailedRequest(failure: FailedRequestRecord): void {
        this.failedRequests.push(failure);
        this.emit("warning", {
            type: "warning",
            data: {
                url: failure.url,
                message: `Request failed: ${failure.reason}`,
                status: failure.status,
            },
            timestamp: Date.now(),
        });
    }

    async abort(): Promise<void> {
        this.aborted = true;
        this.stats.status = "completed";
        this.checkpointScheduler.disarmAll();
        verifyLinksToCrawledPages(this.siteDb);
        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status: "completed",
                completedAt: Date.now(),
                pagesDiscovered: this.stats.pagesDiscovered,
                linksFound: this.stats.linksFound,
                blockedAtUrl: null,
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

    async pause(
        options: {
            blockedAtUrl?: string | null;
            calledFromHandler?: boolean;
            reason?: "wall_clock_cap";
        } = {},
    ): Promise<void> {
        this.isPaused = true;
        this.stats.status = "paused";
        this.checkpointScheduler.disarmCheckpointTimer();

        await waitForCrawlerConcurrencyBelow(
            () => this.crawler?.autoscaledPool?.currentConcurrency,
            options.calledFromHandler ? 1 : 0,
        );

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
            // Keep the depth this URL was reached at. Rewriting it to 0 would
            // re-root the subtree on resume and let the crawl run maxDepth
            // levels deeper than configured.
            const pending = this.pendingRequests.get(key);
            this.pendingRequests.set(key, {
                url: options.blockedAtUrl,
                uniqueKey: key,
                userData: {
                    ...(pending?.userData ?? {}),
                    depth: (pending?.userData?.["depth"] as number | undefined) ?? 0,
                    resumeBlocked: true,
                },
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
            data: { stats: this.stats, ...(options.reason ? { reason: options.reason } : {}) },
            timestamp: Date.now(),
        });

        if (this.crawler) {
            try {
                await this.crawler.teardown();
            } catch {
                // Best-effort cleanup.
            }
        }
    }

    getStats(): DiscoveryStats {
        this.stats.elapsedMs = Date.now() - this.stats.startedAt;
        return { ...this.stats };
    }

    /** Active site-discovery DB session id, when a crawl session exists. */
    getDiscoverySessionId(): number | null {
        return this.sessionId;
    }

    async close(): Promise<void> {
        // Cleanup paths routinely close a crawl that already closed itself, and
        // a second `db.close()` warns about a connection that is not open.
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.closeOnce();
        return this.closePromise;
    }

    private async closeOnce(): Promise<void> {
        // Stop the crawl before dismantling it. Without this an in-flight
        // `start()` keeps driving Crawlee after teardown, and the released
        // process-wide lock lets the next crawl install fresh global storage
        // underneath it — the corruption the lock exists to prevent.
        this.aborted = true;
        this.checkpointScheduler.disarmAll();
        if (this.crawler) {
            try {
                await this.crawler.teardown();
            } catch (err) {
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
        // Let the run finish unwinding (it observes `aborted` after teardown
        // returns) so nothing writes to the DB we are about to close.
        if (this.inFlightRun) {
            const run = this.inFlightRun;
            this.inFlightRun = null;
            await run;
        }

        releaseProcessWideCrawl(this);
        await this.releaseDiscoveryLock();

        if (this.requestQueue) {
            const queueToDrop = this.requestQueue;
            this.requestQueue = null;
            setTimeout(() => {
                void queueToDrop.drop().catch(() => {});
            }, 2_000).unref?.();
        }
        this.db.close();
    }

    /** @internal Used by checkpoint failure tests. */
    async persistQueueState(): Promise<void> {
        return this.checkpointScheduler.persistQueueState();
    }

    private async seedRequestQueue(): Promise<void> {
        if (!this.queuedRequests || this.queuedRequests.length === 0 || !this.requestQueue) {
            return;
        }
        // A checkpoint persisted before the enqueue-layer logout guard existed
        // can still carry logout-shaped URLs; a resume would re-navigate them
        // and kill the restored session. Drop them here too (they were already
        // recorded as links when first extracted).
        const seeds = this.playwrightStorageState
            ? this.queuedRequests.filter((request) => !looksLikeLogoutUrl(request.url))
            : this.queuedRequests;
        await this.requestQueue.addRequests(
            seeds.map((request) => ({
                url: request.url,
                uniqueKey: request.uniqueKey,
                userData: request.userData,
            })),
        );
        for (const request of seeds) {
            const key = request.uniqueKey ?? this.normalizeUrl(request.url);
            this.pendingRequests.set(key, {
                url: request.url,
                uniqueKey: key,
                userData: request.userData,
            });
        }
    }

    private computeStartUrls(): string[] {
        return this.options.continueSession &&
            this.queuedRequests?.length &&
            !this.options.purgeQueueOnResume
            ? []
            : [this.options.startUrl];
    }

    private trackSeedUrls(startUrls: string[]): void {
        for (const seed of startUrls) {
            const key = this.normalizeUrl(seed);
            this.pendingRequests.set(key, {
                url: seed,
                uniqueKey: key,
                userData: { depth: 0 },
            });
        }
    }

    private async handleEmptyResumeQueue(startUrls: string[]): Promise<boolean> {
        if (!this.requestQueue) return false;
        const queueIsEmpty = await this.requestQueue.isEmpty();
        const nothingToDo =
            queueIsEmpty &&
            (!this.queuedRequests || this.queuedRequests.length === 0) &&
            startUrls.length === 0;
        if (!nothingToDo) return false;

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
        verifyLinksToCrawledPages(this.siteDb);
        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status: "completed",
                completedAt: Date.now(),
                pagesDiscovered: this.stats.pagesDiscovered,
                linksFound: this.stats.linksFound,
                blockedAtUrl: null,
            });
        }
        this.emit("session_completed", {
            type: "session_completed",
            data: { stats: this.stats },
            timestamp: Date.now(),
        });
        return true;
    }

    private async finalizeSession(status: "completed", extra?: { reason: string }): Promise<void> {
        this.stats.status = status;
        this.stats.elapsedMs = Date.now() - this.stats.startedAt;
        verifyLinksToCrawledPages(this.siteDb);
        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status,
                completedAt: Date.now(),
                pagesDiscovered: this.stats.pagesDiscovered,
                linksFound: this.stats.linksFound,
                blockedAtUrl: null,
            });
        }
        this.emit("session_completed", {
            type: "session_completed",
            data: { stats: this.stats, ...extra },
            timestamp: Date.now(),
        });
    }

    private async releaseDiscoveryLock(): Promise<void> {
        if (this.discoveryLock) {
            const lock = this.discoveryLock;
            this.discoveryLock = null;
            await lock.release().catch(() => {});
        }
    }

    private async resumeSession(): Promise<void> {
        const activeSession = this.siteDb.getActiveSession();
        if (!activeSession) {
            throw new Error("No active session to resume");
        }

        this.sessionId = activeSession.id ?? null;
        this.emitSessionStarted();
        this.stats.pagesDiscovered = activeSession.pagesDiscovered;
        this.stats.linksFound = activeSession.linksFound;
        this.stats.startedAt = activeSession.startedAt;

        if (!this.options.purgeQueueOnResume) {
            for (const normalizedUrl of this.siteDb.getAllNormalizedUrls()) {
                this.visitedUrls.add(normalizedUrl);
            }
        }

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
            let parsed: QueuedRequestSeed[] = [];
            if (activeSession.queueJson) {
                try {
                    const raw = JSON.parse(activeSession.queueJson) as QueuedRequestSeed[];
                    parsed = Array.isArray(raw) ? raw.filter((item) => Boolean(item?.url)) : [];
                } catch {
                    parsed = [];
                }
            }
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
                // Ignore malformed memory.
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

        if (!this.options.storageStatePath) {
            this.options.storageStatePath = resolveUsableAuthStorageStatePath(
                this.options.projectPath,
            );
        }

        if (!activeSession.id) {
            throw new Error("Active session is missing an ID");
        }

        this.siteDb.updateSession(activeSession.id, { status: "running", blockedAtUrl: null });
        this.emit("session_resumed", {
            type: "session_resumed",
            data: { stats: this.stats },
            timestamp: Date.now(),
        });
    }

    private async startNewSession(): Promise<void> {
        if (!this.options.storageStatePath) {
            this.options.storageStatePath = resolveUsableAuthStorageStatePath(
                this.options.projectPath,
            );
        }

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
        this.emitSessionStarted();
    }

    private emitSessionStarted(): void {
        if (this.sessionId == null) return;
        this.emit("session_started", {
            type: "session_started",
            data: { sessionId: this.sessionId },
            timestamp: Date.now(),
        });
    }

    private loadStorageState(): void {
        const { storageState, warning } = loadPlaywrightStorageState(this.options.storageStatePath);
        this.playwrightStorageState = storageState;
        if (warning && !this.storageStateWarningEmitted) {
            console.warn(warning);
            this.storageStateWarningEmitted = true;
        }
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
}

export { compileExcludeMatcher } from "./crawler/exclude-patterns";
export { summariseNavigationFailure } from "./crawler/failure-summary";
export { extractPageForms } from "./crawler/form-extractor";
export {
    markBrokenLinks,
    verifyLinksToCrawledPages,
    verifyPendingLinks,
} from "./crawler/link-verification";
