import type { GraphStateType } from "../state";
import { extractUrlFromText } from "../utils";
import type { AgentNodeDeps } from "./types";

export const createNavigateNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const historyText = state.conversationHistory.map((msg) => msg.content).join("\n");
        const url =
            state.targetUrl ||
            extractUrlFromText(`${historyText}\n${state.userPrompt}`) ||
            "http://localhost:3000";
        const navResult = await callTool("navigateTo", { url });
        const summary = (navResult.data as { summary?: string; url?: string } | undefined)?.summary || null;
        const currentUrl = (navResult.data as { url?: string } | undefined)?.url || url;
        return {
            currentUrl,
            domSummary: summary,
            pagesVisited: [currentUrl],
            pageSummaries: summary ? [summary] : [],
        };
    };

export const createExploreNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const discover = await callTool("discoverLinks", { includeExternal: false });
        const links =
            (discover.data as { links?: Array<{ text: string; href: string }> } | undefined)?.links || [];
        const visited = new Set(state.pagesVisited || []);
        const toVisit = links.filter((link) => !visited.has(link.href)).slice(0, 3);
        const summaries: string[] = [];
        const newVisited: string[] = [];
        let lastSummary: string | null = state.domSummary || null;
        let lastUrl: string | null = state.currentUrl || null;

        for (const link of toVisit) {
            const nav = await callTool("navigateTo", { url: link.href });
            const summary = (nav.data as { summary?: string; url?: string } | undefined)?.summary || null;
            const url = (nav.data as { url?: string } | undefined)?.url || link.href;
            newVisited.push(url);
            if (summary) {
                summaries.push(summary);
                lastSummary = summary;
            }
            lastUrl = url;
        }

        return {
            pagesVisited: newVisited,
            pageSummaries: summaries,
            domSummary: lastSummary,
            currentUrl: lastUrl,
        };
    };
