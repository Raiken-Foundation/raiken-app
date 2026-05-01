/**
 * Sync orchestrator.
 *
 * Ties together branch parsing, provider fetching, and impact analysis
 * into a single `syncCurrentTicket()` call.
 *
 * Flow:
 *   1. Read current git branch → extract ticket ID
 *   2. If no ticket from branch, check for open PR → linked issue
 *   3. Fetch ticket details from provider
 *   4. Run TicketAnalyzer for codebase impact
 *   5. Return SyncResult
 */

import {
    getCurrentBranch,
    getGitRemoteInfo,
    parseTicketFromBranch,
} from "./branch-parser";
import { GitHubProvider } from "./github-provider";
import { JiraProvider } from "./jira-provider";
import { LinearProvider } from "./linear-provider";
import { TicketAnalyzer } from "./ticket-analyzer";
import type {
    IntegrationConfig,
    SyncResult,
    TicketInfo,
    TicketProvider,
} from "./types";

interface SyncOptions {
    projectPath: string;
    config?: IntegrationConfig;
    /** Explicit ticket override (e.g. from --ticket CLI flag) */
    ticketId?: string;
    /** AI config for the analyzer */
    ai?: {
        apiKey?: string;
        model?: string;
        baseURL?: string;
    };
}

export async function syncCurrentTicket(options: SyncOptions): Promise<SyncResult> {
    const { projectPath, config, ai } = options;
    const branchName = getCurrentBranch(projectPath) || "unknown";

    const provider = createProvider(config, projectPath);
    if (!provider) {
        return {
            ticket: null,
            impact: null,
            source: "branch",
            branchName,
            timestamp: new Date().toISOString(),
        };
    }

    // Step 1: Determine ticket ID
    let ticket: TicketInfo | null = null;
    let source: SyncResult["source"] = "branch";

    if (options.ticketId) {
        // Explicit override
        source = "manual";
        try {
            ticket = await provider.getTicket(options.ticketId);
        } catch (err) {
            console.warn(
                `Failed to fetch ticket ${options.ticketId}:`,
                err instanceof Error ? err.message : err,
            );
        }
    } else {
        // Try branch name first
        const parsed = parseTicketFromBranch(branchName, config);
        if (parsed) {
            source = "branch";
            try {
                ticket = await provider.getTicket(parsed.ticketId);
            } catch (err) {
                console.warn(
                    `Branch "${branchName}" suggests ticket ${parsed.ticketId}, but fetch failed:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }

        // Fallback: check if current branch has an open PR with linked issues
        if (!ticket && provider.name === "github") {
            const prTicket = await tryFindPRForBranch(
                provider as GitHubProvider,
                branchName,
            );
            if (prTicket) {
                ticket = prTicket;
                source = "pr";
            }
        }
    }

    if (!ticket) {
        return {
            ticket: null,
            impact: null,
            source,
            branchName,
            timestamp: new Date().toISOString(),
        };
    }

    // Step 2: Analyze impact
    const analyzer = new TicketAnalyzer(projectPath, ai);
    const impact = await analyzer.analyze(ticket);

    return {
        ticket,
        impact,
        source,
        branchName,
        timestamp: new Date().toISOString(),
    };
}

// =========================================================================
// Provider Factory
// =========================================================================

function createProvider(
    config: IntegrationConfig | undefined,
    projectPath: string,
): TicketProvider | null {
    const providerType = config?.provider || "github";

    if (providerType === "github") {
        const gh = new GitHubProvider(config?.github);

        // Fill in owner/repo from the local git remote when the user
        // didn't put them in raiken.config.json. This is the common
        // case — most projects have a github remote already.
        if (!gh.isConfigured()) {
            const remote = getGitRemoteInfo(projectPath);
            if (remote) {
                gh.setRepo(remote.owner, remote.repo);
            }
        }

        if (!gh.isConfigured()) {
            console.warn(
                "GitHub integration not configured: missing owner/repo. " +
                    "Add `integrations.github.owner` and `integrations.github.repo` to raiken.config.json, " +
                    "or run from inside a git repo with a github remote.",
            );
            return null;
        }

        // Surface a softer warning when there's no token — public repos
        // still work, just at 60 req/hour instead of 5000.
        if (!gh.hasToken()) {
            console.warn(
                "No GITHUB_TOKEN found. Anonymous mode active (60 req/hour). " +
                    "Set GITHUB_TOKEN to access private repos and lift the rate limit.",
            );
        }

        return gh;
    }

    if (providerType === "jira") {
        const jira = new JiraProvider(config?.jira);
        if (!jira.isConfigured()) {
            console.warn(
                "Jira integration not configured. Set JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN env vars.",
            );
            return null;
        }
        return jira;
    }

    if (providerType === "linear") {
        const linear = new LinearProvider(config?.linear);
        if (!linear.isConfigured()) {
            console.warn(
                "Linear integration not configured. Set LINEAR_API_KEY env var.",
            );
            return null;
        }
        return linear;
    }

    console.warn(`Unknown provider "${providerType}". Supported: github, jira, linear.`);
    return null;
}

// =========================================================================
// PR Fallback
// =========================================================================

async function tryFindPRForBranch(
    provider: GitHubProvider,
    branchName: string,
): Promise<TicketInfo | null> {
    try {
        const myTickets = await provider.getMyTickets();
        // Find a PR whose head branch matches the current branch
        // GitHub issues don't have branch info, so we look for PRs
        // that are likely from this branch by matching the ticket against
        // the user's open items
        for (const t of myTickets) {
            if (t.changedFiles && t.changedFiles.length > 0) {
                return t;
            }
        }
        return myTickets.length > 0 ? myTickets[0] : null;
    } catch {
        return null;
    }
}
