import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ChatOpenAI } from "@langchain/openai";
import { BrowserSession } from "../../../browser/session";
import type { GraphStateType } from "../state";
import type { InterruptionInfo } from "../utils";
import {
    extractPageTitle,
    extractUrlFromText,
    getStructuralSignals,
    parseSummaryElements,
    shouldClassifyInterruption,
} from "../utils";
import { classifyInterruption, extractCredentialsWithLLM } from "./classify-interruption";
import type { AgentNodeDeps } from "./types";

function loadExploreMaxPages(projectPath: string): number {
    try {
        const raw = fsSync.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8");
        const config = JSON.parse(raw) as { discovery?: { maxPages?: number } };
        const val = config.discovery?.maxPages;
        if (typeof val === "number" && val > 0) return val;
    } catch {
        // Config missing or invalid
    }
    return 20;
}

async function checkForInterruption(
    summary: string | null,
    userPrompt: string,
    conversationHistory: Array<{ role: string; content: string }>,
    model: ChatOpenAI,
    projectPath: string,
): Promise<InterruptionInfo | null> {
    if (!summary) return null;
    const elements = parseSummaryElements(summary);
    const pageTitle = extractPageTitle(summary);

    let hasOverlay = false;
    try {
        const session = BrowserSession.getInstance(projectPath);
        hasOverlay = await session.hasBlockingOverlay();
    } catch {
        /* browser not active */
    }

    const signals = getStructuralSignals(elements, pageTitle, hasOverlay);
    if (!shouldClassifyInterruption(signals)) return null;
    const credentials = await extractCredentialsWithLLM(userPrompt, conversationHistory, model);
    return classifyInterruption(pageTitle, elements, signals, credentials, model);
}

export const createNavigateNode =
    ({ callTool, projectPath }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const historyText = state.conversationHistory.map((msg) => msg.content).join("\n");

        let rememberedUrl: string | null = null;
        try {
            const { AgentMemory } = await import("../../memory");
            const memory = AgentMemory.getInstance(projectPath);
            rememberedUrl = memory.getPreference("project_base_url") || null;
        } catch {
            /* memory not available */
        }

        const url =
            state.targetUrl ||
            extractUrlFromText(`${historyText}\n${state.userPrompt}`) ||
            rememberedUrl;

        if (!url) {
            return {
                currentUrl: "",
                domSummary:
                    "[Navigation failed: no URL provided. Please specify a URL to navigate to.]",
                pagesVisited: [],
                pageSummaries: [],
                awaitUserMessage:
                    "I need a URL to navigate to. Please provide the base URL of your application.",
                shouldPause: true,
            };
        }

        const navResult = await callTool("navigateTo", { url });

        if (!navResult.success) {
            return {
                currentUrl: url,
                domSummary: `[Navigation failed: ${navResult.message || "unknown error"}]`,
                pagesVisited: [url],
                pageSummaries: [],
            };
        }

        const summary =
            (navResult.data as { summary?: string; url?: string } | undefined)?.summary || null;
        const currentUrl = (navResult.data as { url?: string } | undefined)?.url || url;

        try {
            const { AgentMemory } = await import("../../memory");
            const memory = AgentMemory.getInstance(projectPath);
            const origin = new URL(currentUrl).origin;
            if (origin && origin !== "null") {
                memory.setPreference("project_base_url", origin);
            }
        } catch {
            /* non-critical */
        }

        return {
            currentUrl,
            domSummary: summary,
            pagesVisited: [currentUrl],
            pageSummaries: summary ? [summary] : [],
        };
    };

/**
 * Score a link's relevance to the user's goal so the explore loop
 * prioritizes pages that matter (e.g., "dashboard" when the user
 * wants to test the dashboard) over unrelated pages (e.g., "/blog").
 */
function scoreLinkRelevance(
    link: { text: string; href: string },
    goal: string | null,
    feature: string | null,
): number {
    if (!goal && !feature) return 0;
    const keywords = `${goal || ""} ${feature || ""}`.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return 0;

    const linkText = `${link.text} ${link.href}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
        if (kw.length < 3) continue;
        if (linkText.includes(kw)) score += 1;
    }
    return score;
}

function sortLinksByRelevance(
    links: Array<{ text: string; href: string }>,
    goal: string | null,
    feature: string | null,
): Array<{ text: string; href: string }> {
    if (!goal && !feature) return links;
    return [...links].sort(
        (a, b) => scoreLinkRelevance(b, goal, feature) - scoreLinkRelevance(a, goal, feature),
    );
}

export const createExploreNode =
    ({ callTool, projectPath, model }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const maxPages = state.maxExplorePages ?? loadExploreMaxPages(projectPath);
        const visited = new Set(state.pagesVisited || []);
        const summaries: string[] = [];
        const newVisited: string[] = [];
        let lastSummary: string | null = state.domSummary || null;
        let lastUrl: string | null = state.currentUrl || null;
        let pagesExplored = 0;

        const goal = state.activeGoal || null;
        const feature = state.targetFeature || null;

        let linksToProcess: Array<{ text: string; href: string }> = [];

        // Determine the base origin to avoid following cross-origin links
        const startUrl = state.currentUrl || state.targetUrl || "";
        let baseOrigin: string | null = null;
        try {
            baseOrigin = new URL(startUrl).origin;
        } catch {
            /* no valid start URL */
        }

        const isSameOrigin = (href: string): boolean => {
            if (!baseOrigin) return true;
            try {
                return new URL(href).origin === baseOrigin;
            } catch {
                return false;
            }
        };

        const AUTH_PATH_SEGMENTS =
            /\/(login|signin|sign-in|sign_in|signup|sign-up|sign_up|register|auth|sso|oauth|forgot[-_]?password|reset[-_]?password)\b/i;
        const isAuthPage = (href: string): boolean => {
            try {
                return AUTH_PATH_SEGMENTS.test(new URL(href).pathname);
            } catch {
                return false;
            }
        };

        const isExplorableLink = (href: string): boolean => isSameOrigin(href) && !isAuthPage(href);

        const discoverResult = await callTool("discoverLinks", { includeExternal: false });
        if (discoverResult.success) {
            const initialLinks =
                (
                    discoverResult.data as
                        | { links?: Array<{ text: string; href: string }> }
                        | undefined
                )?.links || [];
            linksToProcess = sortLinksByRelevance(
                initialLinks.filter(
                    (link) => !visited.has(link.href) && isExplorableLink(link.href),
                ),
                goal,
                feature,
            );
        }

        while (linksToProcess.length > 0 && pagesExplored < maxPages) {
            const link = linksToProcess.shift()!;
            if (visited.has(link.href)) continue;

            const nav = await callTool("navigateTo", { url: link.href });
            if (!nav.success) {
                visited.add(link.href);
                continue;
            }

            const summary =
                (nav.data as { summary?: string; url?: string } | undefined)?.summary || null;
            const url = (nav.data as { url?: string } | undefined)?.url || link.href;
            visited.add(url);
            newVisited.push(url);
            pagesExplored++;

            if (summary) {
                summaries.push(summary);
                lastSummary = summary;
            }
            lastUrl = url;

            const interruption = await checkForInterruption(
                summary,
                state.userPrompt,
                state.conversationHistory,
                model,
                projectPath,
            );
            if (interruption) {
                return {
                    pagesVisited: newVisited,
                    pageSummaries: summaries,
                    domSummary: lastSummary,
                    currentUrl: lastUrl,
                    interruption,
                };
            }

            const moreLinks = await callTool("discoverLinks", { includeExternal: false });
            if (moreLinks.success) {
                const newLinks =
                    (
                        moreLinks.data as
                            | { links?: Array<{ text: string; href: string }> }
                            | undefined
                    )?.links || [];
                const fresh = newLinks.filter(
                    (nl) =>
                        !visited.has(nl.href) &&
                        isExplorableLink(nl.href) &&
                        !linksToProcess.some((l) => l.href === nl.href),
                );
                linksToProcess.push(...fresh);
                linksToProcess = sortLinksByRelevance(linksToProcess, goal, feature);
            }
        }

        return {
            pagesVisited: newVisited,
            pageSummaries: summaries,
            domSummary: lastSummary,
            currentUrl: lastUrl,
        };
    };
