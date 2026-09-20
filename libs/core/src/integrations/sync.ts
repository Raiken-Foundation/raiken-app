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

import type { ResolvedAIConfig } from "../agent/ai-providers";
import { getCurrentBranch, getGitRemoteInfo, parseTicketFromBranch } from "./branch-parser";
import { GitHubProvider } from "./github-provider";
import { JiraProvider } from "./jira-provider";
import { LinearProvider } from "./linear-provider";
import { TicketAnalyzer } from "./ticket-analyzer";
import type { IntegrationConfig, SyncResult, TicketInfo, TicketProvider } from "./types";

interface SyncOptions {
    projectPath: string;
    config?: IntegrationConfig;
    /** Explicit ticket override (e.g. from --ticket CLI flag) */
    ticketId?: string;
    /** AI config for the analyzer */
    ai?: ResolvedAIConfig;
}

export async function syncCurrentTicket(options: SyncOptions): Promise<SyncResult> {
    const { projectPath, config, ai } = options;
    const branchName = getCurrentBranch(projectPath) || "unknown";

    // Parse the branch FIRST: when the user hasn't pinned a provider, the
    // detected ticket ID's shape (ENG-123 vs #123) says which provider to
    // use. The old code always defaulted to GitHub, so a Jira/Linear shop
    // got "Invalid GitHub ticket ID" and cascaded into the broken PR
    // fallback (review finding).
    const parsedFromBranch = parseTicketFromBranch(branchName, config);
    const provider = createProvider(
        parsedFromBranch && !config?.provider
            ? { ...config, provider: parsedFromBranch.provider }
            : config,
        projectPath,
    );
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
        if (parsedFromBranch) {
            source = "branch";
            try {
                ticket = await provider.getTicket(parsedFromBranch.ticketId);
            } catch (err) {
                console.warn(
                    `Branch "${branchName}" suggests ticket ${parsedFromBranch.ticketId}, but fetch failed:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }

        // Fallback: an open PR whose HEAD matches the current branch.
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
            console.warn("Linear integration not configured. Set LINEAR_API_KEY env var.");
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
    // Match the PR to the branch via GitHub's head filter — the ONLY correct
    // attribution. The old fallback returned the first assigned ticket with
    // changed files (else myTickets[0]), attributing an arbitrary unrelated
    // ticket to this branch and persisting wrong impact analysis (review
    // finding). No match → null, clearly.
    try {
        return await provider.findPRForBranch(branchName);
    } catch (err) {
        console.warn(
            `PR lookup for branch "${branchName}" failed:`,
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}
