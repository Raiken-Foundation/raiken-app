/**
 * Extracts ticket IDs from git branch names.
 *
 * Handles common conventions:
 *   feat/RAI-123-add-login      → { id: "RAI-123", provider: "jira" }
 *   fix/GH-45-broken-cart       → { id: "45", provider: "github" }
 *   45-fix-broken-cart           → { id: "45", provider: "github" }
 *   feature/PROJ-100            → { id: "PROJ-100", provider: "jira" }
 *   linear/ENG-89-do-stuff      → { id: "ENG-89", provider: "linear" }
 *   fix/issue-78                → { id: "78", provider: "github" }
 */

import { execSync } from "node:child_process";
import type { IntegrationConfig } from "./types";

export interface ParsedBranch {
    ticketId: string;
    provider: "github" | "jira" | "linear";
    branchName: string;
}

const JIRA_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const GITHUB_ISSUE_PATTERN = /(?:^|[/#-])(?:GH-?|issue-?|#)?(\d+)(?:\b|-)/i;
const LINEAR_PATTERN = /\b([A-Z]{2,5}-\d+)\b/;

/**
 * Get the current git branch name.
 *
 * Prefers `git symbolic-ref` over `git rev-parse --abbrev-ref` because
 * symbolic-ref reports the branch name even on unborn branches (a
 * freshly-`git init`-ed repo with no commits yet, which testers WILL
 * hit on their first run). `rev-parse --abbrev-ref` returns the literal
 * string "HEAD" in that case, which we'd then have to filter out.
 *
 * Falls back to `rev-parse` only if `symbolic-ref` fails — covers the
 * detached-HEAD case (e.g. mid-rebase, on a tag), where there's truly
 * no branch to report.
 */
export function getCurrentBranch(cwd?: string): string | null {
    try {
        return execSync("git symbolic-ref --short HEAD", {
            cwd: cwd || process.cwd(),
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null;
    } catch {
        // detached HEAD or no git available → no branch
        return null;
    }
}

/**
 * Get the remote origin URL to infer owner/repo for GitHub.
 */
export function getGitRemoteInfo(cwd?: string): { owner: string; repo: string } | null {
    try {
        const url = execSync("git remote get-url origin", {
            cwd: cwd || process.cwd(),
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        // SSH: git@github.com:owner/repo.git
        const sshMatch = url.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2] };
        }

        // HTTPS: https://github.com/owner/repo.git
        const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
        if (httpsMatch) {
            return { owner: httpsMatch[1], repo: httpsMatch[2] };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extract a ticket ID from a branch name.
 *
 * When `config.provider` is set, only matches patterns for that provider.
 * Otherwise tries all providers in order: Jira → Linear → GitHub.
 */
export function parseTicketFromBranch(
    branchName: string,
    config?: Partial<IntegrationConfig>,
): ParsedBranch | null {
    const provider = config?.provider;
    const customPatterns = config?.branchPatterns;

    if (customPatterns && customPatterns.length > 0) {
        for (const pattern of customPatterns) {
            try {
                const re = new RegExp(pattern);
                const match = branchName.match(re);
                if (match && match[1]) {
                    return {
                        ticketId: match[1],
                        provider: provider || inferProvider(match[1]),
                        branchName,
                    };
                }
            } catch {
                // invalid regex, skip
            }
        }
    }

    if (!provider || provider === "github") {
        // Check for explicit GH- prefix first
        const ghExplicit = branchName.match(/GH-?(\d+)/i);
        if (ghExplicit) {
            return { ticketId: ghExplicit[1], provider: "github", branchName };
        }
    }

    if (!provider || provider === "jira") {
        const jiraMatch = branchName.match(JIRA_PATTERN);
        if (jiraMatch) {
            return { ticketId: jiraMatch[1], provider: "jira", branchName };
        }
    }

    if (!provider || provider === "linear") {
        const linearMatch = branchName.match(LINEAR_PATTERN);
        if (linearMatch) {
            return { ticketId: linearMatch[1], provider: "linear", branchName };
        }
    }

    if (!provider || provider === "github") {
        const ghMatch = branchName.match(GITHUB_ISSUE_PATTERN);
        if (ghMatch) {
            return { ticketId: ghMatch[1], provider: "github", branchName };
        }
    }

    return null;
}

function inferProvider(ticketId: string): "github" | "jira" | "linear" {
    if (/^\d+$/.test(ticketId)) return "github";
    if (/^[A-Z]{2,5}-\d+$/.test(ticketId)) return "jira";
    return "github";
}
