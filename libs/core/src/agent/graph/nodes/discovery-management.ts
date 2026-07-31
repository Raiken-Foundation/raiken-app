import type { ToolResult } from "../../tools";
import type { GraphStateType } from "../state";
import type { DiscoveryManagementAction } from "../utils";
import type { AgentNodeDeps } from "./types";

const DISCOVERY_SUBJECT = /\b(discovery|discovered\s+data|site\s+(?:map|knowledge))\b/i;
const SITE_CRAWL_SUBJECT =
    /\b(?:(?:site|app|website)\s+crawl|crawl\s+(?:the\s+)?(?:site|app|website|https?:\/\/)|(?:restart|rerun|re-run)\s+(?:the\s+)?crawl)\b/i;
const START_VERB = /\b(run|start|restart|rerun|re-run|crawl|discover)\b/i;
const AGAIN = /\b(?:again|do\s+it\s+again|from\s+scratch|fresh)\b/i;
const EXPLICIT_DISCOVERY_CLEAR =
    /\b(?:(?:clear|reset|wipe|purge)\s+(?:all\s+|the\s+)?(?:site\s+)?(?:discovery|crawl)(?:\s+(?:data|results|history|state))?|(?:delete|erase)\s+(?:all\s+|the\s+)?(?:site\s+)?(?:discovery|crawl)\s+(?:data|results|history|state)|(?:discovery|crawl)(?:\s+(?:data|results|history|state))?\s+(?:clear|reset|wiped|deleted|purged))\b/i;

export function inferDiscoveryManagementAction(prompt: string): DiscoveryManagementAction | null {
    if (!DISCOVERY_SUBJECT.test(prompt) && !SITE_CRAWL_SUBJECT.test(prompt)) return null;
    const clear = explicitlyRequestsDiscoveryClear(prompt);
    const start = START_VERB.test(prompt) || AGAIN.test(prompt);
    if (clear && start) return "clearAndStart";
    if (clear) return "clear";
    if (start) return "start";
    return null;
}

export function explicitlyRequestsDiscoveryClear(prompt: string): boolean {
    return EXPLICIT_DISCOVERY_CLEAR.test(prompt);
}

function validHttpUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? parsed.toString()
            : null;
    } catch {
        return null;
    }
}

function failureSummary(action: "clear" | "start", result: ToolResult): string {
    const verb = action === "clear" ? "clear discovery data" : "start site discovery";
    return `Answers:
- I could not ${verb}. No successful action is being claimed.

Evidence:
- The ${action === "clear" ? "clearDiscoveryData" : "startDiscovery"} tool returned: ${result.message || "unknown error"}.

Unknowns / Next checks:
- Resolve the reported error, then try again. You can also use \`${action === "clear" ? "raiken knowledge clear" : "raiken discover <url>"}\` directly.`;
}

async function previousStartUrl(
    callTool: AgentNodeDeps["callTool"],
): Promise<{ url: string | null; error: string | null }> {
    const overview = await callTool("getDiscoveryOverview", {});
    if (!overview.success || !overview.data) {
        return {
            url: null,
            error: overview.message || "Discovery overview could not be loaded.",
        };
    }
    const data = overview.data as {
        latestSession?: { startUrl?: string | null } | null;
    };
    return { url: validHttpUrl(data.latestSession?.startUrl), error: null };
}

export const createManageDiscoveryNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const inferred = inferDiscoveryManagementAction(state.userPrompt);
        let action = inferred ?? state.discoveryAction;

        if (!action) {
            return {
                summary:
                    "Answers:\n- I could not determine which discovery action to perform, so no data was changed.\n\nEvidence:\n- The request did not clearly ask to clear, start, or rerun site discovery.\n\nUnknowns / Next checks:\n- Say `clear discovery data`, `start discovery at <url>`, or `clear discovery and rerun it`.",
            };
        }

        const clearIsExplicit = explicitlyRequestsDiscoveryClear(state.userPrompt);
        if (action === "clearAndStart" && !clearIsExplicit) {
            action = "start";
        }
        if (action === "clear" && !clearIsExplicit) {
            return {
                summary:
                    "Answers:\n- I did not clear discovery data because the current request did not explicitly authorize deletion.\n\nEvidence:\n- Clearing removes persisted pages, links, blockers, sessions, and crawler state.\n\nUnknowns / Next checks:\n- Say `clear discovery data` explicitly if you want that destructive action.",
            };
        }

        let startUrl = validHttpUrl(state.targetUrl);
        if ((action === "start" || action === "clearAndStart") && !startUrl) {
            const previous = await previousStartUrl(callTool);
            startUrl = previous.url;
            if (previous.error) {
                return {
                    summary: `Answers:
- I could not recover the previous discovery URL, so no data was changed and no crawl was started.

Evidence:
- getDiscoveryOverview returned: ${previous.error}.

Unknowns / Next checks:
- Resolve the discovery database error, or repeat the request with a full HTTP(S) URL.`,
                };
            }
            if (!startUrl) {
                return {
                    summary:
                        "Answers:\n- I could not start site discovery because no previous start URL is available. No discovery data was cleared and no crawl was started.\n\nEvidence:\n- getDiscoveryOverview did not contain a valid HTTP(S) start URL.\n\nUnknowns / Next checks:\n- Repeat the request with the full URL, for example: `clear discovery and rerun it at http://127.0.0.1:5100`.",
                };
            }
        }

        if (action === "clear" || action === "clearAndStart") {
            const cleared = await callTool("clearDiscoveryData", {});
            if (!cleared.success) {
                return { summary: failureSummary("clear", cleared) };
            }
            if (action === "clear") {
                return {
                    summary: `Answers:
- Discovery data was cleared.

Evidence:
- clearDiscoveryData completed: ${cleared.message}.

Unknowns / Next checks:
- None.`,
                };
            }
        }

        if (!startUrl) {
            return {
                summary:
                    "Answers:\n- I could not start discovery because no valid HTTP(S) URL was available. No crawl was started.\n\nEvidence:\n- startDiscovery requires an absolute URL.\n\nUnknowns / Next checks:\n- Provide the full URL and try again.",
            };
        }

        const started = await callTool("startDiscovery", { url: startUrl });
        if (!started.success) {
            if (action === "clearAndStart") {
                return {
                    summary: `Answers:
- Discovery data was cleared, but I could not start the fresh crawl.

Evidence:
- clearDiscoveryData completed successfully.
- startDiscovery returned: ${started.message || "unknown error"}.

Unknowns / Next checks:
- Retry with \`raiken discover ${startUrl}\` or ask me to start discovery again.`,
                };
            }
            return { summary: failureSummary("start", started) };
        }

        return {
            summary: `Answers:
- ${action === "clearAndStart" ? "Discovery data was cleared and a fresh crawl was started" : "Site discovery was started"} at ${startUrl}.
- The crawl is running in the background; this chat turn did not wait for it to finish.

Evidence:
${action === "clearAndStart" ? "- clearDiscoveryData completed successfully.\n" : ""}- startDiscovery accepted the detached crawl: ${started.message}.

Unknowns / Next checks:
- Ask me for discovery progress at any time, or use \`/discover status\`. Use \`/knowledge\` for results persisted so far.`,
        };
    };
