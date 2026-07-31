import { tool } from "ai";
import { z } from "zod";
import { getProjectApplication } from "../../application";
import { formatDOMContext } from "../../browser/dom-capture";
import { acquireProjectOperation } from "../../operations";
import { DiscoveryQueryService } from "../../site-discovery/query-service";
import { ensureBrowserStarted, getBoundBrowserSession } from "./shared/browser-session";
import type { AgentToolGroupDeps, ToolResult } from "./types";

/** Tool names owned by the discovery / knowledge group. */
export const DISCOVERY_KNOWLEDGE_TOOL_NAMES = [
    "captureDOM",
    "getDiscoveryOverview",
    "listDiscoveredPages",
    "getDiscoveredPageSnapshot",
    "clearDiscoveryData",
    "startDiscovery",
] as const;

export type DiscoveryKnowledgeToolName = (typeof DISCOVERY_KNOWLEDGE_TOOL_NAMES)[number];

export function createDiscoveryKnowledgeTools(deps: AgentToolGroupDeps) {
    const { projectPath, getAuthPrecondition, isActionAuthorized, operationHeld, signal } = deps;

    return {
        captureDOM: tool({
            description:
                "Capture the live DOM from a running web application. Use this to understand the current UI state for test generation.",
            inputSchema: z.object({
                url: z
                    .string()
                    .url()
                    .describe("URL to capture (e.g., http://localhost:3000/login)"),
            }),
            execute: async (
                params,
            ): Promise<
                ToolResult<{ summary: string; elementCount: number; formCount: number }>
            > => {
                const { url } = params as { url: string };
                try {
                    const session = getBoundBrowserSession(projectPath);
                    await ensureBrowserStarted(session, projectPath, getAuthPrecondition, true);

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
                let discovery: DiscoveryQueryService | null = null;
                try {
                    discovery = new DiscoveryQueryService(projectPath);
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
                                blockerType: blocker.blockerType ?? blocker.category ?? "unknown",
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
                } finally {
                    discovery?.close();
                }
            },
        }),

        listDiscoveredPages: tool({
            description:
                "List discovered pages from persisted site discovery data. Useful for chat-based review of discovered routes.",
            inputSchema: z.object({
                limit: z.number().optional().default(20).describe("Maximum pages to return"),
                offset: z.number().optional().default(0).describe("Offset for pagination"),
            }),
            execute: async (
                params,
            ): Promise<
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
                let discovery: DiscoveryQueryService | null = null;
                try {
                    discovery = new DiscoveryQueryService(projectPath);
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
                } finally {
                    discovery?.close();
                }
            },
        }),

        getDiscoveredPageSnapshot: tool({
            description:
                "Get the persisted discovered-page snapshot (ARIA snapshot JSON) for a specific URL.",
            inputSchema: z.object({
                url: z.string().url().describe("Discovered page URL"),
            }),
            execute: async (
                params,
            ): Promise<
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
                let discovery: DiscoveryQueryService | null = null;
                try {
                    discovery = new DiscoveryQueryService(projectPath);
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
                } finally {
                    discovery?.close();
                }
            },
        }),

        clearDiscoveryData: tool({
            description:
                "Permanently clear persisted site-discovery pages, links, blockers, sessions, and crawler state. Use only when the current user message explicitly requests clearing or deleting discovery data. Returns the resulting runtime phase.",
            inputSchema: z.strictObject({}),
            execute: async (): Promise<ToolResult<{ phase: string }>> => {
                if (!isActionAuthorized("clearDiscoveryData")) {
                    return {
                        success: false,
                        message:
                            "Discovery data was not cleared because the current user request did not explicitly authorize that deletion.",
                    };
                }
                if (signal?.aborted) {
                    return {
                        success: false,
                        message: "Discovery clear was cancelled before it started.",
                    };
                }
                let lease = null;
                try {
                    lease = operationHeld
                        ? null
                        : await acquireProjectOperation(projectPath, "discovery", signal);
                    const result = await getProjectApplication(projectPath).discovery.clearData();
                    return {
                        success: result.success,
                        data: { phase: result.runtime.phase },
                        message: result.message,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to clear discovery data: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                } finally {
                    await lease?.release().catch(() => undefined);
                }
            },
        }),

        startDiscovery: tool({
            description:
                "Start a detached site-discovery crawl and return immediately while it runs in the background. Requires a full start URL; optional limits must be positive integers. Returns the live discovery phase and current URL.",
            inputSchema: z.strictObject({
                url: z.string().url().describe("Absolute URL where discovery should begin"),
                maxPages: z.number().int().positive().optional(),
                maxDepth: z.number().int().nonnegative().optional(),
                timeout: z.number().int().positive().optional(),
                skipAuth: z.boolean().optional(),
                excludePatterns: z.array(z.string().min(1)).optional(),
            }),
            execute: async (
                params,
            ): Promise<ToolResult<{ phase: string; currentUrl: string | null }>> => {
                if (signal?.aborted) {
                    return {
                        success: false,
                        message: "Discovery start was cancelled before it began.",
                    };
                }
                const input = params as {
                    url: string;
                    maxPages?: number;
                    maxDepth?: number;
                    timeout?: number;
                    skipAuth?: boolean;
                    excludePatterns?: string[];
                };
                try {
                    const result = await getProjectApplication(projectPath).discovery.start(input);
                    return {
                        success: result.success,
                        data: {
                            phase: result.runtime.phase,
                            currentUrl: result.runtime.currentUrl,
                        },
                        message: result.message,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to start discovery: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),
    };
}

export type DiscoveryKnowledgeTools = ReturnType<typeof createDiscoveryKnowledgeTools>;
