/**
 * Site Discovery Crawler
 *
 * Autonomous crawler that discovers web application structure using Crawlee.
 * Integrates with AuthDetector and persists results to database.
 */

import {
    PlaywrightCrawler,
    RequestQueue,
    Configuration,
    type PlaywrightCrawlingContext,
} from "crawlee";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import { AuthDetector } from "./auth-detector";
import type {
    DiscoveryOptions,
    DiscoveryStats,
} from "./types";
import { normalizeUrl } from "./url-utils";

export class SiteDiscovery extends EventEmitter {
    private crawler: PlaywrightCrawler | null = null;
    private db: CodeGraphDB;
    private siteDb: SiteKnowledgeDB;
    private authDetector: AuthDetector;
    private options: Required<DiscoveryOptions>;
    private sessionId: number | null = null;
    private stats: DiscoveryStats;
    private visitedUrls = new Set<string>();
    private isPaused = false;
    private startOrigin: string | null = null;
    private requestQueue: RequestQueue | null = null;
    private queuedRequests: Array<{
        url: string;
        uniqueKey?: string;
        userData?: Record<string, unknown>;
    }> | null = null;
    private storageState: {
        cookies?: Array<Record<string, unknown>>;
        origins?: Array<{
            origin: string;
            localStorage?: Array<{ name: string; value: string }>;
            sessionStorage?: Array<{ name: string; value: string }>;
        }>;
    } | null = null;
    private storageStateApplied = new WeakSet<BrowserContext>();
    private storageStateWarningEmitted = false;

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
        };

        // Initialize database
        this.db = new CodeGraphDB(this.options.projectPath);
        this.siteDb = new SiteKnowledgeDB(
            this.db.getRawDatabase(),
            this.options.projectPath
        );

        // Initialize auth detector
        this.authDetector = new AuthDetector(this.options.projectPath);

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
            // Direct Crawlee's file-based storage into .raiken/crawlee/
            const crawleeDir = path.join(this.options.projectPath, ".raiken", "crawlee");
            fs.mkdirSync(crawleeDir, { recursive: true });
            process.env["CRAWLEE_STORAGE_DIR"] = crawleeDir;
            Configuration.getGlobalConfig().set("purgeOnStart", !this.options.continueSession);

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

            this.requestQueue = await RequestQueue.open();

            if (this.queuedRequests && this.queuedRequests.length > 0) {
                await this.requestQueue.addRequests(
                    this.queuedRequests.map((request) => ({
                        url: request.url,
                        uniqueKey: request.uniqueKey,
                        userData: request.userData,
                    }))
                );
            }

            // Create Crawlee crawler
            this.crawler = new PlaywrightCrawler({
                maxRequestsPerCrawl: this.options.maxPages,
                maxConcurrency: this.options.maxConcurrency,
                requestHandlerTimeoutSecs: this.options.timeout / 1000,
                headless: true,
                requestQueue: this.requestQueue,
                launchContext: {
                    launchOptions: {
                        // Basic launch options (no storageState here — it's a context option)
                    },
                },
                preNavigationHooks: this.storageState
                    ? [
                          async ({ page }) => {
                              await this.applyStorageState(page);
                          },
                      ]
                    : [],
            });

            // Bind request handler to this instance
            this.crawler.router.addDefaultHandler(
                this.handleRequest.bind(this)
            );

            // Start crawling
            const startUrls =
                this.options.continueSession && this.queuedRequests?.length
                    ? []
                    : [this.options.startUrl];
            await this.crawler.run(startUrls);

            if (this.isPaused) {
                this.stats.elapsedMs = Date.now() - this.stats.startedAt;
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
     * Pause the discovery process.
     */
    async pause(): Promise<void> {
        this.isPaused = true;
        this.stats.status = "paused";

        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                status: "paused",
            });
        }

        await this.persistQueueState();

        this.emit("session_paused", {
            type: "session_paused",
            data: { stats: this.stats },
            timestamp: Date.now(),
        });

        // Gracefully stop the crawler
        if (this.crawler) {
            await this.crawler.teardown();
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

        const resumeUrl = activeSession.blockedAtUrl || activeSession.startUrl;
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

        if (activeSession.queueJson) {
            try {
                const parsed = JSON.parse(activeSession.queueJson) as Array<{
                    url: string;
                    uniqueKey?: string;
                    userData?: Record<string, unknown>;
                }>;
                this.queuedRequests = parsed.filter((item) => Boolean(item?.url));
            } catch {
                this.queuedRequests = null;
            }
        }

        // Check for auth state file
        const authStatePath = path.join(
            this.options.projectPath,
            ".raiken",
            "auth-state.json"
        );

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
        const authStatePath = path.join(
            this.options.projectPath,
            ".raiken",
            "auth-state.json"
        );

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
     */
    private async handleRequest(
        context: PlaywrightCrawlingContext
    ): Promise<void> {
        const { page, request, enqueueLinks, response } = context;
        const url = request.url;
        const depth = (request.userData["depth"] as number) || 0;

        // Check if paused
        if (this.isPaused) {
            return;
        }

        // Update current state
        this.stats.currentUrl = url;
        this.stats.currentDepth = Math.max(this.stats.currentDepth, depth);

        // Check max depth
        if (depth > this.options.maxDepth) {
            return;
        }

        // Check if URL should be excluded
        if (this.shouldExclude(url)) {
            return;
        }

        // Normalize URL
        const normalizedUrl = this.normalizeUrl(url);

        // Check if already visited
        if (this.visitedUrls.has(normalizedUrl)) {
            return;
        }

        this.visitedUrls.add(normalizedUrl);

        // Wait for page to load
        try {
            await page.waitForLoadState("domcontentloaded", {
                timeout: this.options.timeout,
            });
        } catch {
            // Timeout - continue anyway
        }

        // Check for authentication blockers
        const authBlocker = await this.authDetector.detect(
            page,
            url,
            response ?? undefined
        );

        if (authBlocker && this.options.pauseOnAuth) {
            // Save auth blocker
            this.siteDb.saveAuthBlocker(authBlocker);
            this.stats.authBlockersFound++;

            // Update session
            if (this.sessionId) {
                this.siteDb.updateSession(this.sessionId, {
                    status: "paused",
                    blockedAtUrl: url,
                });
            }

            // Emit auth blocked event
            this.emit("auth_blocked", {
                type: "auth_blocked",
                data: { blocker: authBlocker },
                timestamp: Date.now(),
            });

            // Pause the crawler
            await this.pause();
            return;
        }

        if (response && response.status() >= 400) {
            const status = response.status();
            const linkStatus =
                status === 401 || status === 403 ? "auth_required" : "broken";
            this.markBrokenLinks(
                url,
                normalizedUrl,
                `HTTP ${status}`,
                linkStatus
            );
            return;
        }

        const resolvedUrl = response?.url() || url;
        const resolvedNormalized = this.normalizeUrl(resolvedUrl);
        this.verifyPendingLinks(resolvedUrl, resolvedNormalized);

        // Get page snapshot (aria tree for accessibility context)
        let snapshotJson: string | null = null;
        try {
            const snapshot = await page.locator("body").ariaSnapshot();
            snapshotJson = snapshot || null;
        } catch {
            // Snapshot failed - continue without it
        }

        // Get page title
        const title = await page.title();

        // Save page to database
        const now = Date.now();
        const existingPage = this.siteDb.getPage(url);

        if (existingPage) {
            this.siteDb.updatePageVisit(url);
        } else {
            this.siteDb.savePage({
                projectPath: this.options.projectPath,
                url,
                normalizedUrl,
                title,
                snapshotJson,
                parentUrl: (request.userData["parentUrl"] as string) || null,
                navigationAction: null,
                depth,
                discoveredAt: now,
                lastVisitedAt: now,
                visitCount: 1,
            });

            this.stats.pagesDiscovered++;

            // Emit page discovered event
            this.emit("page_discovered", {
                type: "page_discovered",
                data: {
                    page: {
                        url,
                        title,
                        depth,
                    },
                },
                timestamp: now,
            });
        }

        // Extract and save links
        const links = await page.locator("a[href]").all();
        const startOrigin = this.startOrigin;

        if (!startOrigin) {
            return;
        }

        for (const link of links) {
            try {
                const href = await link.getAttribute("href");
                const linkText = await link.textContent();
                const role = await link.getAttribute("role");
                const dataTestId = await link.getAttribute("data-testid");

                if (!href) continue;
                const cleanedHref = href.trim();
                if (
                    cleanedHref.startsWith("#") ||
                    cleanedHref.startsWith("mailto:") ||
                    cleanedHref.startsWith("tel:") ||
                    cleanedHref.startsWith("javascript:")
                ) {
                    continue;
                }

                // Resolve relative URLs
                let absoluteUrl: string;
                try {
                    absoluteUrl = new URL(cleanedHref, url).toString();
                } catch {
                    continue;
                }

                const linkOrigin = new URL(absoluteUrl).origin;

                if (startOrigin !== linkOrigin) {
                    continue;
                }

                const selector = this.buildLinkSelector(
                    cleanedHref,
                    (linkText || "").trim(),
                    dataTestId
                );

                // Save link
                this.siteDb.saveLink({
                    projectPath: this.options.projectPath,
                    fromUrl: url,
                    toUrl: absoluteUrl,
                    selector,
                    linkText: linkText?.trim() || null,
                    elementRole: role,
                    status: "pending",
                    errorMessage: null,
                    discoveredAt: now,
                    verifiedAt: null,
                });

                this.stats.linksFound++;
            } catch {
                // Failed to process link - skip it
                continue;
            }
        }

        // Enqueue links for further crawling
        await enqueueLinks({
            selector: "a[href]",
            userData: {
                depth: depth + 1,
                parentUrl: url,
            },
            strategy: "same-hostname",
        });

        // Update session progress
        if (this.sessionId) {
            this.siteDb.updateSession(this.sessionId, {
                pagesDiscovered: this.stats.pagesDiscovered,
                linksFound: this.stats.linksFound,
            });
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
     * Check if a URL should be excluded.
     */
    private shouldExclude(url: string): boolean {
        for (const pattern of this.options.excludePatterns) {
            if (url.includes(pattern)) {
                return true;
            }
        }
        return false;
    }

    private normalizeUrl(url: string): string {
        return normalizeUrl(url);
    }

    private getOriginSafe(url: string): string | null {
        try {
            return new URL(url).origin;
        } catch {
            return null;
        }
    }

    private loadStorageState(): void {
        if (!this.options.storageStatePath) {
            this.storageState = null;
            return;
        }
        try {
            if (!fs.existsSync(this.options.storageStatePath)) {
                if (!this.storageStateWarningEmitted) {
                    console.warn(
                        `⚠️  Storage state not found at ${this.options.storageStatePath}`
                    );
                    this.storageStateWarningEmitted = true;
                }
                this.storageState = null;
                return;
            }
            const raw = fs.readFileSync(this.options.storageStatePath, "utf-8");
            this.storageState = JSON.parse(raw);
        } catch {
            if (!this.storageStateWarningEmitted) {
                console.warn("⚠️  Failed to load storage state for discovery");
                this.storageStateWarningEmitted = true;
            }
            this.storageState = null;
        }
    }

    private async applyStorageState(page: Page): Promise<void> {
        const state = this.storageState;
        if (!state) {
            return;
        }
        const context = page.context();
        if (this.storageStateApplied.has(context)) {
            return;
        }
        this.storageStateApplied.add(context);

        const cookies = Array.isArray(state.cookies) ? state.cookies : [];
        if (cookies.length > 0) {
            await context.addCookies(cookies as Array<{
                name: string;
                value: string;
                domain?: string;
                path?: string;
                url?: string;
                expires?: number;
                httpOnly?: boolean;
                secure?: boolean;
                sameSite?: "Strict" | "Lax" | "None";
            }>);
        }

        const origins = Array.isArray(state.origins) ? state.origins : [];
        if (origins.length > 0) {
            await context.addInitScript((items) => {
                try {
                    const entry = items.find((item) => item.origin === location.origin);
                    if (!entry) return;
                    if (Array.isArray(entry.localStorage)) {
                        for (const kv of entry.localStorage) {
                            localStorage.setItem(kv.name, kv.value);
                        }
                    }
                    if (Array.isArray(entry.sessionStorage)) {
                        for (const kv of entry.sessionStorage) {
                            sessionStorage.setItem(kv.name, kv.value);
                        }
                    }
                } catch {
                    // ignore storage injection errors
                }
            }, origins);
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
        status: "broken" | "auth_required" = "broken"
    ): void {
        const pendingLinks = this.siteDb.getPendingLinksTo(url);
        for (const link of pendingLinks) {
            this.siteDb.updateLinkStatus(
                link.fromUrl,
                link.toUrl,
                status,
                errorMessage
            );
        }

        if (normalizedUrl !== url) {
            const normalizedLinks = this.siteDb.getPendingLinksTo(normalizedUrl);
            for (const link of normalizedLinks) {
                this.siteDb.updateLinkStatus(
                    link.fromUrl,
                    link.toUrl,
                    status,
                    errorMessage
                );
            }
        }
    }

    private buildLinkSelector(
        href: string,
        linkText: string,
        dataTestId: string | null
    ): string {
        if (dataTestId) {
            return `a[data-testid="${this.escapeSelectorText(dataTestId)}"]`;
        }

        if (href) {
            return `a[href="${this.escapeSelectorText(href)}"]`;
        }

        const trimmed = linkText.trim();
        if (trimmed && trimmed.length <= 80) {
            return `a:has-text("${this.escapeSelectorText(trimmed)}")`;
        }

        return "a[href]";
    }

    private escapeSelectorText(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    private async persistQueueState(): Promise<void> {
        if (!this.sessionId || !this.requestQueue) {
            return;
        }

        try {
            const queueDir = path.join(
                this.options.projectPath,
                "storage",
                "request_queues",
                "default"
            );
            if (!fs.existsSync(queueDir)) {
                return;
            }

            const files = fs
                .readdirSync(queueDir)
                .filter((file) => file.endsWith(".json"));
            const serialized: Array<{
                url: string;
                uniqueKey?: string;
                userData?: Record<string, unknown>;
            }> = [];

            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(queueDir, file), "utf-8");
                    const outer = JSON.parse(raw) as { json?: string };
                    if (!outer.json) {
                        continue;
                    }
                    const request = JSON.parse(outer.json) as {
                        url?: string;
                        uniqueKey?: string;
                        userData?: Record<string, unknown>;
                        handledAt?: string | null;
                    };
                    if (!request.url || request.handledAt) {
                        continue;
                    }
                    serialized.push({
                        url: request.url,
                        uniqueKey: request.uniqueKey,
                        userData: request.userData,
                    });
                } catch {
                    // Ignore malformed queue entries
                }
            }

            this.siteDb.updateSession(this.sessionId, {
                queueJson: JSON.stringify(serialized),
            });
        } catch {
            // Ignore queue persistence errors
        }
    }

    /**
     * Clean up resources.
     */
    async close(): Promise<void> {
        if (this.crawler) {
            await this.crawler.teardown();
        }
        this.db.close();
    }
}
