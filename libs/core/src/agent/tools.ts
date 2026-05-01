/**
 * Agent Tools - AI SDK Tool Definitions
 *
 * These tools are available to the LLM during reasoning.
 * The LLM decides when to call each tool based on the user's request.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProjectContext } from "../analysis/project-context";
import { AgentMemory } from "./memory";
import { TestRunner, type TestRunResult } from "../testing/runner";
import { formatDOMContext, type DOMContext } from "../browser/dom-capture";
import { createSaveAction, createRunAction, shouldSkipHITL, type HITLAction } from "./hitl-types";
import { BrowserSession } from "../browser/session";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "../site-discovery/db";
import * as fsSync from "node:fs";
export type { HITLAction } from "./hitl-types";

/**
 * Ensure a relative file path stays within the project root.
 * Throws if the resolved path escapes the project directory.
 */
function safePath(projectPath: string, filePath: string): string {
    const resolved = path.resolve(projectPath, filePath);
    const root = path.resolve(projectPath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`Path traversal denied: ${filePath}`);
    }
    return resolved;
}

/**
 * Resolve auth storage state path for the browser session.
 * Checks raiken.config.json first, then .raiken/auth-state.json.
 */
function resolveAuthStatePath(projectPath: string): string | undefined {
    try {
        const configPath = path.join(projectPath, "raiken.config.json");
        const raw = fsSync.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as { auth?: { storageStatePath?: string } };
        if (config.auth?.storageStatePath) {
            const resolved = safePath(projectPath, config.auth.storageStatePath);
            if (fsSync.existsSync(resolved)) return resolved;
        }
    } catch {
        // Config missing, invalid, or path traversal denied
    }
    const fallback = path.join(projectPath, ".raiken", "auth-state.json");
    if (fsSync.existsSync(fallback)) return fallback;
    return undefined;
}

interface PageSnapshot {
    url: string;
    title: string;
    elements: number;
    forms: number;
    summary: string;
}

function buildPageSnapshot(domContext: DOMContext): PageSnapshot {
    const summary = formatDOMContext(domContext);
    return {
        url: domContext.url,
        title: domContext.title,
        elements: domContext.interactiveElements.length,
        forms: domContext.formFields.length,
        summary,
    };
}

/**
 * Get a BrowserSession pre-bound to the project's persistent selector memory
 * so every click/fill/hover records its outcome in `selector_history`.
 *
 * Use this everywhere instead of `BrowserSession.getInstance(projectPath)`
 * so the compounding selector value actually accrues.
 */
function getBoundBrowserSession(projectPath: string): BrowserSession {
    const session = BrowserSession.getInstance(projectPath);
    const memory = AgentMemory.getInstance(projectPath);
    session.setSelectorMemory(memory.asSelectorMemory());
    return session;
}

function formatToolError<T = unknown>(context: string, error: unknown): ToolResult<T> {
    return {
        success: false,
        message: `${context}: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
}

// Lazy shared DB connection for site knowledge persistence during a tools session.
// Bounded to MAX_SITE_DB_ENTRIES entries; evicts least-recently-used when full.
const MAX_SITE_DB_ENTRIES = 5;
const siteDbCache = new Map<string, { db: CodeGraphDB; siteDb: SiteKnowledgeDB; lastUsed: number }>();

function getSiteDb(projectPath: string): { db: CodeGraphDB; siteDb: SiteKnowledgeDB } {
    const cached = siteDbCache.get(projectPath);
    if (cached) {
        cached.lastUsed = Date.now();
        return cached;
    }

    // Evict oldest entry if cache is full
    if (siteDbCache.size >= MAX_SITE_DB_ENTRIES) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of siteDbCache) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            const evicted = siteDbCache.get(oldestKey);
            siteDbCache.delete(oldestKey);
            try { evicted?.db.close(); } catch { /* ignore */ }
        }
    }

    const db = new CodeGraphDB(projectPath);
    const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
    siteDbCache.set(projectPath, { db, siteDb, lastUsed: Date.now() });
    return { db, siteDb };
}

export function closeSiteDbCache(): void {
    for (const [, entry] of siteDbCache) {
        try { entry.db.close(); } catch { /* ignore */ }
    }
    siteDbCache.clear();
}

// Auto-cleanup on process exit
process.once("SIGINT", closeSiteDbCache);
process.once("SIGTERM", closeSiteDbCache);
process.once("beforeExit", closeSiteDbCache);

function persistPageDiscovery(projectPath: string, snapshot: PageSnapshot, parentUrl?: string): void {
    try {
        const { siteDb } = getSiteDb(projectPath);
        const now = Date.now();
        const existing = siteDb.getPage(snapshot.url);

        if (existing) {
            siteDb.updatePageVisit(snapshot.url);
            return;
        }

        // Compute depth from parent when available. Fresh navigations (no
        // parent) are treated as depth 0 roots. Parent lookup failure falls
        // back to 0 so we never block persistence on a depth read.
        let depth = 0;
        if (parentUrl) {
            try {
                const parent = siteDb.getPage(parentUrl);
                if (parent && typeof parent.depth === "number") {
                    depth = parent.depth + 1;
                }
            } catch {
                // Parent not in DB yet; treat as root.
            }
        }

        siteDb.savePage({
            projectPath,
            url: snapshot.url,
            normalizedUrl: snapshot.url,
            title: snapshot.title,
            snapshotJson: snapshot.summary,
            parentUrl: parentUrl ?? null,
            navigationAction: null,
            depth,
            discoveredAt: now,
            lastVisitedAt: now,
            visitCount: 1,
        });
    } catch {
        // Non-critical: don't break the agent if persistence fails
    }
}

function persistLinksDiscovery(
    projectPath: string,
    fromUrl: string,
    links: Array<{ text: string; href: string; suggestedSelectors?: string[] }>
): void {
    try {
        const { siteDb } = getSiteDb(projectPath);
        const now = Date.now();

        for (const link of links) {
            // Prefer the first DOM-derived selector (built from observed
            // attributes: testid, role+name, aria-label, id). Only fall back
            // to href-attribute CSS when the page element genuinely had no
            // other signal. Never invent one.
            const suggested = link.suggestedSelectors ?? [];
            const selector = suggested.find((s) => s && s.length > 0) ?? null;

            if (!selector) {
                // No DOM-derived selector available; skip rather than
                // persist a brittle fabricated one.
                continue;
            }

            siteDb.saveLink({
                projectPath,
                fromUrl,
                toUrl: link.href,
                selector,
                linkText: link.text || null,
                elementRole: "link",
                status: "pending",
                errorMessage: null,
                discoveredAt: now,
                verifiedAt: null,
            });
        }
    } catch {
        // Non-critical
    }
}

/**
 * Autonomy settings for tool execution
 */
export interface AutonomySettings {
    autoSaveTests: boolean;
    autoRunTests: boolean;
    autoCorrect: "suggest" | "apply" | "off";
    autoLearn: "confirm" | "auto" | "off";
}

/**
 * Tool result that may require HITL confirmation
 */
export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    message: string;
    hitlRequired?: boolean;
    hitlAction?: HITLAction;
}

/**
 * Context passed to tool factory functions
 */
export interface ToolContext {
    projectPath: string;
    /** Autonomy settings for HITL decisions */
    autonomy?: AutonomySettings;
}

/**
 * Default autonomy settings (conservative - always ask)
 */
const defaultAutonomy: AutonomySettings = {
    autoSaveTests: false,
    autoRunTests: false,
    autoCorrect: "suggest",
    autoLearn: "confirm",
};

/**
 * Create the agent tools with project context
 */
export function createAgentTools(ctx: ToolContext) {
    const { projectPath, autonomy = defaultAutonomy } = ctx;

    return {
        /**
         * Search the codebase for files related to a query
         */
        searchCodebase: tool({
            description:
                "Search the codebase for files related to a query. Use this to find relevant source files before reading them.",
            inputSchema: z.object({
                query: z.string().describe('Search query (e.g., "login form", "auth service", "user validation")'),
                limit: z.number().optional().default(10).describe("Maximum number of files to return"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { query, limit = 10 } = params as { query: string; limit?: number };
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }
                    const files = projectContext.findRelevantFiles(query, limit);
                    return {
                        success: true,
                        data: files,
                        message: files.length > 0 ? `Found ${files.length} relevant files` : "No matching files found",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Read the contents of a file
         */
        readFile: tool({
            description: "Read the contents of a source file. Use this to understand code before generating tests.",
            inputSchema: z.object({
                filePath: z.string().describe("File path relative to project root (e.g., src/components/LoginForm.tsx)"),
            }),
            execute: async (params): Promise<ToolResult<{ content: string; lines: number }>> => {
                const { filePath } = params as { filePath: string };
                try {
                    const fullPath = safePath(projectPath, filePath);
                    const content = await fs.readFile(fullPath, "utf-8");
                    const lines = content.split("\n").length;
                    return {
                        success: true,
                        data: { content, lines },
                        message: `Read ${filePath} (${lines} lines)`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * List files in a directory
         */
        listDirectory: tool({
            description: "List files in a directory. Use this to explore the project structure.",
            inputSchema: z.object({
                dirPath: z.string().describe("Directory path relative to project root (e.g., src/components)"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { dirPath } = params as { dirPath: string };
                try {
                    const fullPath = safePath(projectPath, dirPath);
                    const entries = await fs.readdir(fullPath, { withFileTypes: true });
                    const files = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                    return {
                        success: true,
                        data: files,
                        message: `Found ${files.length} items in ${dirPath}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to list directory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Capture the live DOM from a running web application
         */
        captureDOM: tool({
            description:
                "Capture the live DOM from a running web application. Use this to understand the current UI state for test generation.",
            inputSchema: z.object({
                url: z.string().url().describe("URL to capture (e.g., http://localhost:3000/login)"),
            }),
            execute: async (params): Promise<ToolResult<{ summary: string; elementCount: number; formCount: number }>> => {
                const { url } = params as { url: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    if (!session.isActive()) {
                        const storageStatePath = resolveAuthStatePath(projectPath);
                        await session.start({ headless: true, storageStatePath });
                    }

                    const domContext = await session.navigate(url);
                    const summary = formatDOMContext(domContext);

                    return {
                        success: true,
                        data: {
                            summary,
                            elementCount: domContext.interactiveElements.length,
                            formCount: domContext.formFields.length,
                        },
                        message: `Captured DOM: ${domContext.interactiveElements.length} interactive elements, ${domContext.formFields.length} form fields`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `DOM capture failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Save a file to the project
         * Checks autonomy settings - either saves immediately or returns HITL action
         */
        saveFile: tool({
            description:
                "Save content to a file. Depending on autonomy settings, this may save immediately or ask for confirmation.",
            inputSchema: z.object({
                filePath: z.string().describe("File path relative to project root (e.g., tests/login.spec.ts)"),
                content: z.string().describe("File content to save"),
                testName: z.string().optional().describe("Name of the test (for display)"),
            }),
            execute: async (params): Promise<ToolResult<{ path: string; saved: boolean }>> => {
                const { filePath, content, testName } = params as { filePath: string; content: string; testName?: string };
                const name = testName || path.basename(filePath, path.extname(filePath));

                // Check if we can skip HITL
                if (shouldSkipHITL("save", autonomy)) {
                    // Auto-save enabled - save immediately
                    try {
                        const fullPath = safePath(projectPath, filePath);
                        // Ensure directory exists
                        await fs.mkdir(path.dirname(fullPath), { recursive: true });
                        await fs.writeFile(fullPath, content, "utf-8");
                        return {
                            success: true,
                            data: { path: filePath, saved: true },
                            message: `Saved ${filePath}`,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            message: `Failed to save file: ${error instanceof Error ? error.message : "Unknown error"}`,
                        };
                    }
                }

                // HITL required - return action for confirmation
                const hitlAction = createSaveAction(content, filePath, name);
                return {
                    success: true,
                    data: { path: filePath, saved: false },
                    message: `Ready to save ${filePath}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),

        /**
         * Run a Playwright test file
         * Checks autonomy settings - either runs immediately or returns HITL action
         */
        runTest: tool({
            description:
                "Execute a Playwright test file and return results. Depending on autonomy settings, this may run immediately or ask for confirmation.",
            inputSchema: z.object({
                testFile: z.string().describe("Test file path relative to project root"),
                headed: z.boolean().optional().default(false).describe("Run with visible browser"),
            }),
            execute: async (params): Promise<ToolResult<TestRunResult[] | { status: string }>> => {
                const { testFile, headed = false } = params as { testFile: string; headed?: boolean };

                // Check if we can skip HITL
                if (shouldSkipHITL("run", autonomy)) {
                    // Auto-run enabled - execute immediately
                    try {
                        const runner = new TestRunner(projectPath);
                        const results = await runner.runTest(testFile, { headed });
                        const passed = results.every((r) => r.status === "passed");

                        return {
                            success: passed,
                            data: results,
                            message: passed
                                ? `All tests passed (${results.length} test(s))`
                                : `${results.filter((r) => r.status !== "passed").length} test(s) failed`,
                        };
                    } catch (error) {
                        return {
                            success: false,
                            message: `Test execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                        };
                    }
                }

                // HITL required - return action for confirmation
                const hitlAction = createRunAction(testFile, path.basename(testFile));
                return {
                    success: true,
                    data: { status: "pending" },
                    message: `Ready to run ${testFile}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),

        /**
         * Get memory context (learned preferences, selector history)
         */
        getMemoryContext: tool({
            description:
                "Get learned preferences and selector history. Use this to understand what has worked in the past.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    selectorStrategy: string | null;
                    successfulSelectors: Array<{ element: string; selector: string }>;
                    recentFailures: Array<{ testName: string; error: string }>;
                }>
            > => {
                try {
                    const memory = AgentMemory.getInstance(projectPath);
                    const context = memory.buildPromptContext();

                    return {
                        success: true,
                        data: {
                            selectorStrategy: context.selectorStrategy,
                            successfulSelectors: context.successfulSelectors.map((s) => ({
                                element: s.element,
                                selector: s.selector,
                            })),
                            recentFailures: context.recentFailures,
                        },
                        message: `Loaded memory: ${context.successfulSelectors.length} known selectors, ${context.recentFailures.length} recent failures`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to load memory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get project structure overview
         */
        getProjectOverview: tool({
            description: "Get an overview of the project structure including modules and file counts.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    fileCount: number;
                    modules: Array<{ name: string; fileCount: number }>;
                }>
            > => {
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }

                    const modules = projectContext.getModules();
                    const fileCount = projectContext.getFileCount();

                    return {
                        success: true,
                        data: {
                            fileCount,
                            modules: modules.slice(0, 10).map((m) => ({
                                name: m.name,
                                fileCount: m.files.length,
                            })),
                        },
                        message: `Project has ${fileCount} files across ${modules.length} modules`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get project overview: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get site discovery overview from persisted discovery data.
         */
        getDiscoveryOverview: tool({
            description:
                "Get persisted site discovery overview including stats, latest session, and unresolved auth blockers.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    stats: {
                        pagesCount: number;
                        linksCount: number;
                        verifiedLinksCount: number;
                        brokenLinksCount: number;
                        authBlockersCount: number;
                        unresolvedBlockersCount: number;
                    };
                    latestSession: {
                        id: number | null;
                        startUrl: string;
                        status: string;
                        pagesDiscovered: number;
                        linksFound: number;
                        startedAt: number;
                        completedAt: number | null;
                        blockedAtUrl: string | null;
                        maxPages: number | null;
                        maxDepth: number | null;
                    } | null;
                    unresolvedBlockers: Array<{
                        id: number | null;
                        url: string;
                        blockerType: string;
                        discoveredAt: number;
                    }>;
                }>
            > => {
                try {
                    const discovery = new DiscoveryQueryService(projectPath);
                    const overview = discovery.getOverview();
                    return {
                        success: true,
                        data: {
                            stats: overview.stats,
                            latestSession: overview.latestSession
                                ? {
                                      id: overview.latestSession.id ?? null,
                                      startUrl: overview.latestSession.startUrl,
                                      status: overview.latestSession.status,
                                      pagesDiscovered: overview.latestSession.pagesDiscovered,
                                      linksFound: overview.latestSession.linksFound,
                                      startedAt: overview.latestSession.startedAt,
                                      completedAt: overview.latestSession.completedAt ?? null,
                                      blockedAtUrl: overview.latestSession.blockedAtUrl ?? null,
                                      maxPages: overview.latestSession.maxPages ?? null,
                                      maxDepth: overview.latestSession.maxDepth ?? null,
                                  }
                                : null,
                            unresolvedBlockers: overview.unresolvedBlockers.map((blocker) => ({
                                id: blocker.id ?? null,
                                url: blocker.url,
                                blockerType:
                                    blocker.blockerType ?? blocker.category ?? "unknown",
                                discoveredAt: blocker.discoveredAt,
                            })),
                        },
                        message:
                            overview.stats.pagesCount > 0
                                ? `Loaded discovery overview with ${overview.stats.pagesCount} pages`
                                : "No discovery data found",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to load discovery overview: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * List discovered pages from persisted discovery data.
         */
        listDiscoveredPages: tool({
            description:
                "List discovered pages from persisted site discovery data. Useful for chat-based review of discovered routes.",
            inputSchema: z.object({
                limit: z.number().optional().default(20).describe("Maximum pages to return"),
                offset: z.number().optional().default(0).describe("Offset for pagination"),
            }),
            execute: async (params): Promise<
                ToolResult<{
                    pages: Array<{
                        url: string;
                        title: string | null;
                        depth: number;
                        visitCount: number;
                        discoveredAt: number;
                        lastVisitedAt: number;
                    }>;
                    total: number;
                    hasMore: boolean;
                    limit: number;
                    offset: number;
                }>
            > => {
                const { limit = 20, offset = 0 } = params as { limit?: number; offset?: number };
                try {
                    const discovery = new DiscoveryQueryService(projectPath);
                    const result = discovery.listPages({ limit, offset });
                    return {
                        success: true,
                        data: {
                            pages: result.pages.map((page) => ({
                                url: page.url,
                                title: page.title,
                                depth: page.depth,
                                visitCount: page.visitCount,
                                discoveredAt: page.discoveredAt,
                                lastVisitedAt: page.lastVisitedAt,
                            })),
                            total: result.total,
                            hasMore: result.hasMore,
                            limit: result.limit,
                            offset: result.offset,
                        },
                        message:
                            result.total > 0
                                ? `Returned ${result.pages.length} discovered pages (${result.total} total)`
                                : "No discovered pages found",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to list discovered pages: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get a persisted ARIA snapshot for a discovered page URL.
         */
        getDiscoveredPageSnapshot: tool({
            description:
                "Get the persisted discovered-page snapshot (ARIA snapshot JSON) for a specific URL.",
            inputSchema: z.object({
                url: z.string().url().describe("Discovered page URL"),
            }),
            execute: async (params): Promise<
                ToolResult<{
                    url: string;
                    normalizedUrl: string;
                    title: string | null;
                    snapshotJson: string | null;
                    depth: number;
                    discoveredAt: number;
                    lastVisitedAt: number;
                } | null>
            > => {
                const { url } = params as { url: string };
                try {
                    const discovery = new DiscoveryQueryService(projectPath);
                    const page = discovery.getPageSnapshot(url);
                    if (!page) {
                        return {
                            success: true,
                            data: null,
                            message: `No discovered snapshot found for ${url}`,
                        };
                    }
                    return {
                        success: true,
                        data: {
                            url: page.url,
                            normalizedUrl: page.normalizedUrl,
                            title: page.title,
                            snapshotJson: page.snapshotJson,
                            depth: page.depth,
                            discoveredAt: page.discoveredAt,
                            lastVisitedAt: page.lastVisitedAt,
                        },
                        message: `Loaded discovered snapshot for ${url}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get discovered snapshot: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        // =====================================================================
        // Browser Session Tools
        // =====================================================================

        /**
         * Start a browser session for web app exploration
         */
        startBrowser: tool({
            description: "Start a browser session for exploring and testing a web application. Call this before navigating to URLs.",
            inputSchema: z.object({
                headless: z.boolean().optional().default(false).describe("Run in headless mode (true) or visible mode (false). Defaults to visible."),
            }),
            execute: async (params): Promise<ToolResult<{ active: boolean }>> => {
                const { headless = false } = params as { headless?: boolean };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    const storageStatePath = resolveAuthStatePath(projectPath);
                    await session.start({ headless, storageStatePath });
                    return {
                        success: true,
                        data: { active: true },
                        message: `Browser started (headless: ${headless})`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to start browser: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Close the browser session
         */
        closeBrowser: tool({
            description: "Close the browser session when done with exploration.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ closed: boolean }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.close();
                    return {
                        success: true,
                        data: { closed: true },
                        message: "Browser session closed",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to close browser: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Navigate to a URL and capture the page
         */
        navigateTo: tool({
            description: "Navigate to a URL in the browser and capture the page state. Automatically starts the browser if not running. Returns interactive elements and form fields found.",
            inputSchema: z.object({
                url: z.string().url().describe("URL to navigate to"),
            }),
            execute: async (params): Promise<ToolResult<PageSnapshot>> => {
                const { url } = params as { url: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    if (!session.isActive()) {
                        const storageStatePath = resolveAuthStatePath(projectPath);
                        await session.start({ headless: false, storageStatePath });
                    }

                    let previousUrl: string | undefined;
                    try { previousUrl = session.getCurrentUrl(); } catch { /* browser just started */ }
                    const domContext = await session.navigate(url);
                    const snapshot = buildPageSnapshot(domContext);

                    persistPageDiscovery(projectPath, snapshot, previousUrl ?? undefined);

                    return {
                        success: true,
                        data: snapshot,
                        message: `Navigated to ${snapshot.title}: ${snapshot.elements} elements, ${snapshot.forms} form fields`,
                    };
                } catch (error) {
                    return formatToolError("Navigation failed", error);
                }
            },
        }),

        /**
         * Click an element on the page
         */
        clickElement: tool({
            description: "Click an element on the page using a selector or array of selectors.",
            inputSchema: z.object({
                selector: z.union([z.string(), z.array(z.string())]).describe("Selector or array of DOM-derived selectors to try"),
            }),
            execute: async (params): Promise<ToolResult<{ clicked: boolean }>> => {
                const { selector } = params as { selector: string | string[] };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.click(selector);
                    return {
                        success: true,
                        data: { clicked: true },
                        message: `Clicked: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Click failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Fill an input field
         */
        fillInput: tool({
            description: "Fill an input field with text (clears existing value first).",
            inputSchema: z.object({
                selector: z.union([z.string(), z.array(z.string())]).describe("Selector or array of DOM-derived selectors to try"),
                value: z.string().describe("Value to fill"),
            }),
            execute: async (params): Promise<ToolResult<{ filled: boolean }>> => {
                const { selector, value } = params as { selector: string | string[]; value: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.fill(selector, value);
                    return {
                        success: true,
                        data: { filled: true },
                        message: `Filled ${Array.isArray(selector) ? selector[0] : selector} with value`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Fill failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Press a keyboard key
         */
        pressKey: tool({
            description: "Press a keyboard key (e.g., 'Enter', 'Tab', 'Escape').",
            inputSchema: z.object({
                key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')"),
            }),
            execute: async (params): Promise<ToolResult<{ pressed: boolean }>> => {
                const { key } = params as { key: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.press(key);
                    return {
                        success: true,
                        data: { pressed: true },
                        message: `Pressed: ${key}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Key press failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Capture current page state
         */
        captureCurrentPage: tool({
            description: "Capture the current page state without navigating. Use this after interactions to see what changed.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<PageSnapshot>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    if (!session.isActive()) {
                        const storageStatePath = resolveAuthStatePath(projectPath);
                        await session.start({ headless: false, storageStatePath });
                    }
                    const domContext = await session.captureCurrentPage();
                    const snapshot = buildPageSnapshot(domContext);

                    return {
                        success: true,
                        data: snapshot,
                        message: `Captured ${snapshot.title}: ${snapshot.elements} elements`,
                    };
                } catch (error) {
                    return formatToolError("Capture failed", error);
                }
            },
        }),

        /**
         * Wait for an element to appear
         */
        waitForElement: tool({
            description: "Wait for an element to appear on the page.",
            inputSchema: z.object({
                selector: z.union([z.string(), z.array(z.string())]).describe("Selector or array of selectors to wait for"),
                timeout: z.number().optional().default(5000).describe("Timeout in milliseconds"),
            }),
            execute: async (params): Promise<ToolResult<{ found: boolean }>> => {
                const { selector, timeout } = params as { selector: string | string[]; timeout?: number };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.waitForSelector(selector, timeout);
                    return {
                        success: true,
                        data: { found: true },
                        message: `Element found: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Wait failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Select option from dropdown
         */
        selectOption: tool({
            description: "Select an option from a dropdown/select element.",
            inputSchema: z.object({
                selector: z.union([z.string(), z.array(z.string())]).describe("Selector or array of selectors for the select element"),
                value: z.string().describe("Option value to select"),
            }),
            execute: async (params): Promise<ToolResult<{ selected: boolean }>> => {
                const { selector, value } = params as { selector: string | string[]; value: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await session.selectOption(selector, value);
                    return {
                        success: true,
                        data: { selected: true },
                        message: `Selected ${value} from ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Select failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Check or uncheck a checkbox
         */
        toggleCheckbox: tool({
            description: "Check or uncheck a checkbox.",
            inputSchema: z.object({
                selector: z.union([z.string(), z.array(z.string())]).describe("Selector or array of selectors for the checkbox"),
                checked: z.boolean().describe("True to check, false to uncheck"),
            }),
            execute: async (params): Promise<ToolResult<{ toggled: boolean }>> => {
                const { selector, checked } = params as { selector: string | string[]; checked: boolean };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    if (checked) {
                        await session.check(selector);
                    } else {
                        await session.uncheck(selector);
                    }
                    return {
                        success: true,
                        data: { toggled: true },
                        message: `Checkbox ${checked ? "checked" : "unchecked"}: ${Array.isArray(selector) ? selector[0] : selector}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Toggle failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Get current URL
         */
        getCurrentUrl: tool({
            description: "Get the current URL of the browser.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ url: string }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    const url = session.getCurrentUrl();
                    return {
                        success: true,
                        data: { url },
                        message: `Current URL: ${url}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get URL: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        /**
         * Save browser auth state for future sessions
         */
        saveAuthState: tool({
            description: "Save the current browser authentication state (cookies, localStorage) so future sessions start already logged in. Call this after the user has manually logged in.",
            inputSchema: z.object({}),
            execute: async (): Promise<ToolResult<{ saved: boolean; path: string }>> => {
                try {
                    const session = getBoundBrowserSession(projectPath);
                    const fs = await import("node:fs");
                    const authDir = path.join(projectPath, ".raiken");
                    if (!fs.existsSync(authDir)) {
                        fs.mkdirSync(authDir, { recursive: true });
                    }
                    const authPath = path.join(authDir, "auth-state.json");
                    await session.saveAuthState(authPath);
                    return {
                        success: true,
                        data: { saved: true, path: authPath },
                        message: `Auth state saved. Future sessions will start authenticated.`,
                    };
                } catch (error) {
                    return formatToolError("Failed to save auth state", error);
                }
            },
        }),

        /**
         * Discover all links on the current page (lightweight, for exploration)
         */
        discoverLinks: tool({
            description: "Quickly discover all links on the current page. Use this for app exploration before deciding which pages to visit. Faster than full page capture.",
            inputSchema: z.object({
                includeExternal: z.boolean().optional().default(false).describe("Include external links (default: false)"),
            }),
            execute: async (params): Promise<ToolResult<{ links: Array<{ text: string; href: string }>; totalFound: number }>> => {
                const { includeExternal } = params as { includeExternal?: boolean };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    if (!session.isActive()) {
                        const storageStatePath = resolveAuthStatePath(projectPath);
                        await session.start({ headless: false, storageStatePath });
                    }
                    const allLinks = await session.discoverLinks();
                    
                    const links = includeExternal 
                        ? allLinks 
                        : allLinks.filter(l => !l.isExternal);

                    const currentUrl = session.getCurrentUrl() ?? "";
                    const persisted = links.map(l => ({
                        text: l.text,
                        href: l.href,
                        suggestedSelectors: l.suggestedSelectors,
                    }));
                    persistLinksDiscovery(projectPath, currentUrl, persisted);
                    const mapped = links.map((l) => ({ text: l.text, href: l.href }));

                    return {
                        success: true,
                        data: {
                            links: mapped,
                            totalFound: links.length,
                        },
                        message: `Found ${links.length} links on page`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to discover links: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        // =====================================================================
        // Agent Control Tools (for ToolLoopAgent forced tool calling)
        // =====================================================================

        /**
         * Signal task completion - NO execute function, stops the agent loop
         */
        done: tool({
            description: "Signal that you have finished the task. Call this when exploration is complete or when you have completed the user's request. This stops the agent loop.",
            inputSchema: z.object({
                summary: z.string().describe("Summary of what you found or did"),
                suggestedTests: z.array(z.string()).optional().describe("List of suggested test scenarios based on exploration"),
                pagesVisited: z.array(z.string()).optional().describe("List of pages/URLs that were visited"),
            }),
            // NO execute function - calling this tool stops the agent loop
        }),

        /**
         * Send a message to the user - for questions or progress updates
         */
        respond: tool({
            description: "Send a message to the user. Use this when you need to ask a clarifying question, report progress, or provide information that requires user acknowledgment before continuing.",
            inputSchema: z.object({
                message: z.string().describe("Message to send to the user"),
                needsInput: z.boolean().optional().default(false).describe("Whether you need user input to continue (true = wait for response)"),
                options: z.array(z.string()).optional().describe("Optional list of choices for the user to pick from"),
            }),
            execute: async (params): Promise<ToolResult<{ messageSent: boolean; awaitingInput: boolean }>> => {
                const { message, needsInput = false, options } = params as { 
                    message: string; 
                    needsInput?: boolean; 
                    options?: string[] 
                };
                return {
                    success: true,
                    data: { messageSent: true, awaitingInput: needsInput },
                    message: options ? `${message}\nOptions: ${options.join(", ")}` : message,
                };
            },
        }),

        /**
         * Pause and wait for user input (no execute function)
         * Use this when you need the user to respond before continuing.
         */
        awaitUser: tool({
            description: "Pause and ask the user for input. This stops the agent loop until the user responds.",
            inputSchema: z.object({
                message: z.string().describe("Question or prompt for the user"),
                options: z.array(z.string()).optional().describe("Optional list of choices for the user to pick from"),
            }),
            // NO execute function - calling this tool pauses the agent loop
        }),
    };
}

/**
 * Type for the tools object
 */
export type AgentTools = ReturnType<typeof createAgentTools>;
