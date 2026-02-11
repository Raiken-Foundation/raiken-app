/**
 * Site Discovery Crawler
 *
 * Autonomous crawler that discovers web application structure using Crawlee.
 * Integrates with AuthDetector and persists results to database.
 */

import { PlaywrightCrawler, type PlaywrightCrawlingContext } from "crawlee";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import { AuthDetector } from "./auth-detector";
import type {
    DiscoveryOptions,
    DiscoveryStats,
    DiscoveryEventType,
    DiscoveryEvent,
    SessionStatus,
} from "./types";

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
            (this.db as any).db,
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
            // Check if resuming a session
            if (this.options.continueSession) {
                await this.resumeSession();
            } else {
                await this.startNewSession();
            }

            // Create Crawlee crawler
            this.crawler = new PlaywrightCrawler({
                maxRequestsPerCrawl: this.options.maxPages,
                maxConcurrency: this.options.maxConcurrency,
                requestHandlerTimeoutSecs: this.options.timeout / 1000,
                headless: true,
                launchContext: {
                    launchOptions: {
                        // Load storage state if provided (for auth)
                        ...(this.options.storageStatePath
                            ? {
                                  storageState: this.options.storageStatePath,
                              }
                            : {}),
                    },
                },
                async requestHandler(context) {
                    await this.handleRequest(context);
                },
            });

            // Bind request handler to this instance
            this.crawler.router.addDefaultHandler(
                this.handleRequest.bind(this)
            );

            // Start crawling
            await this.crawler.run([this.options.startUrl]);

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

        // Update session status
        this.siteDb.updateSession(activeSession.id!, {
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
        const depth = (request.userData.depth as number) || 0;

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
        } catch (error) {
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
            const blockerId = this.siteDb.saveAuthBlocker(authBlocker);
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

        // Get page snapshot
        let snapshotJson: string | null = null;
        try {
            const snapshot = await page.accessibility.snapshot();
            snapshotJson = snapshot ? JSON.stringify(snapshot) : null;
        } catch (error) {
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
                parentUrl: (request.userData.parentUrl as string) || null,
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

        for (const link of links) {
            try {
                const href = await link.getAttribute("href");
                const linkText = await link.textContent();
                const role = await link.getAttribute("role");

                if (!href) continue;

                // Resolve relative URLs
                const absoluteUrl = new URL(href, url).toString();

                // Check if same domain
                const startDomain = new URL(this.options.startUrl).hostname;
                const linkDomain = new URL(absoluteUrl).hostname;

                if (startDomain !== linkDomain) {
                    continue; // Skip external links
                }

                // Save link
                this.siteDb.saveLink({
                    projectPath: this.options.projectPath,
                    fromUrl: url,
                    toUrl: absoluteUrl,
                    selector: "a[href]", // Simplified selector
                    linkText: linkText?.trim() || null,
                    elementRole: role,
                    status: "pending",
                    errorMessage: null,
                    discoveredAt: now,
                    verifiedAt: null,
                });

                this.stats.linksFound++;
            } catch (error) {
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

    /**
     * Normalize URL for consistent comparison.
     */
    private normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            let normalized = `${parsed.origin}${parsed.pathname}`;
            if (normalized.endsWith("/") && normalized !== `${parsed.origin}/`) {
                normalized = normalized.slice(0, -1);
            }
            return normalized;
        } catch {
            return url;
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
