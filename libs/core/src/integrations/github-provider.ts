/**
 * GitHub ticket provider.
 *
 * Uses the GitHub REST API (no SDK dependency) to fetch
 * issues, pull requests, changed files, and linked issues.
 *
 * Auth: GITHUB_TOKEN env var or config.github.token
 */

import type { ChangedFile, IntegrationConfig, TicketInfo, TicketProvider } from "./types";

const API_BASE = "https://api.github.com";

export class GitHubProvider implements TicketProvider {
    readonly name = "github" as const;
    private token: string | null;
    private owner: string;
    private repo: string;

    constructor(config?: IntegrationConfig["github"]) {
        this.token = config?.token || process.env["GITHUB_TOKEN"] || null;
        this.owner = config?.owner || "";
        this.repo = config?.repo || "";
    }

    setRepo(owner: string, repo: string): void {
        this.owner = owner;
        this.repo = repo;
    }

    /**
     * Configured = we know which repo to talk to. The token is OPTIONAL:
     * the GitHub REST API accepts anonymous reads against public repos
     * (60 req/hour rate-limited instead of 5000), so requiring a token
     * up-front would lock out a huge class of legitimate use — querying
     * any public OSS issue/PR. Callers that need higher quota or access
     * to private repos should still set `GITHUB_TOKEN`; surface that to
     * users via the `hasToken()` helper rather than gating off-the-shelf
     * functionality on it.
     */
    isConfigured(): boolean {
        return !!this.owner && !!this.repo;
    }

    /** True iff a token is available (env or config). Public-repo reads
     * still work without one, but at lower rate limits. */
    hasToken(): boolean {
        return !!this.token;
    }

    async getTicket(ticketId: string): Promise<TicketInfo> {
        const numericId = parseInt(ticketId, 10);
        if (isNaN(numericId)) {
            throw new Error(`Invalid GitHub ticket ID: "${ticketId}". Must be a number.`);
        }

        // Try as PR first (richer data), fall back to issue
        const pr = await this.fetchPR(numericId);
        if (pr) return pr;

        const issue = await this.fetchIssue(numericId);
        if (issue) return issue;

        throw new Error(`GitHub issue/PR #${numericId} not found in ${this.owner}/${this.repo}`);
    }

    async getMyTickets(): Promise<TicketInfo[]> {
        const user = await this.fetchAuthenticatedUser();
        if (!user) {
            throw new Error(
                "Could not determine authenticated GitHub user. Check your GITHUB_TOKEN.",
            );
        }

        const issues = await this.apiFetch<GitHubIssue[]>(
            `/repos/${this.owner}/${this.repo}/issues?assignee=${user}&state=open&per_page=20`,
        );

        const tickets: TicketInfo[] = [];
        for (const issue of issues) {
            const isPR = !!issue.pull_request;
            let changedFiles: ChangedFile[] | undefined;
            if (isPR) {
                changedFiles = await this.getChangedFiles(String(issue.number));
            }

            tickets.push({
                id: String(issue.number),
                title: issue.title,
                description: issue.body || "",
                labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name || "")),
                assignee: issue.assignee?.login,
                status: issue.state,
                url: issue.html_url,
                provider: "github",
                changedFiles,
                linkedTickets: this.extractLinkedIssues(issue.body || ""),
            });
        }

        return tickets;
    }

    async getChangedFiles(ticketId: string): Promise<ChangedFile[]> {
        const numericId = parseInt(ticketId, 10);
        try {
            const files = await this.apiFetch<GitHubPRFile[]>(
                `/repos/${this.owner}/${this.repo}/pulls/${numericId}/files?per_page=100`,
            );

            return files.map((f) => ({
                path: f.filename,
                status: mapFileStatus(f.status),
                additions: f.additions,
                deletions: f.deletions,
                previousPath: f.previous_filename,
            }));
        } catch {
            return [];
        }
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private async fetchPR(number: number): Promise<TicketInfo | null> {
        try {
            const pr = await this.apiFetch<GitHubPR>(
                `/repos/${this.owner}/${this.repo}/pulls/${number}`,
            );

            const changedFiles = await this.getChangedFiles(String(number));

            return {
                id: String(pr.number),
                title: pr.title,
                description: pr.body || "",
                labels: pr.labels.map((l) => l.name || ""),
                assignee: pr.assignee?.login || pr.user?.login,
                status: pr.state,
                url: pr.html_url,
                provider: "github",
                changedFiles,
                linkedTickets: this.extractLinkedIssues(pr.body || ""),
            };
        } catch {
            return null;
        }
    }

    private async fetchIssue(number: number): Promise<TicketInfo | null> {
        try {
            const issue = await this.apiFetch<GitHubIssue>(
                `/repos/${this.owner}/${this.repo}/issues/${number}`,
            );

            if (issue.pull_request) {
                return this.fetchPR(number);
            }

            return {
                id: String(issue.number),
                title: issue.title,
                description: issue.body || "",
                labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name || "")),
                assignee: issue.assignee?.login,
                status: issue.state,
                url: issue.html_url,
                provider: "github",
                linkedTickets: this.extractLinkedIssues(issue.body || ""),
            };
        } catch {
            return null;
        }
    }

    private async fetchAuthenticatedUser(): Promise<string | null> {
        try {
            const user = await this.apiFetch<{ login: string }>("/user");
            return user.login;
        } catch {
            return null;
        }
    }

    /**
     * Extract issue references from markdown text.
     * Handles: #123, owner/repo#123, GH-123, closes #123, fixes #123
     */
    private extractLinkedIssues(text: string): string[] {
        const ids = new Set<string>();
        const patterns = [
            /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
            /(?:^|\s)#(\d+)\b/gm,
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text)) !== null) {
                ids.add(match[1]);
            }
        }

        return Array.from(ids);
    }

    private async apiFetch<T>(endpoint: string): Promise<T> {
        const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;

        const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };

        if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`GitHub API error ${response.status}: ${response.statusText}. ${body}`);
        }

        return response.json() as Promise<T>;
    }
}

// =========================================================================
// GitHub API response types (minimal, only what we use)
// =========================================================================

interface GitHubLabel {
    name?: string;
}

interface GitHubUser {
    login: string;
}

interface GitHubIssue {
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: Array<string | GitHubLabel>;
    assignee: GitHubUser | null;
    pull_request?: { url: string };
}

interface GitHubPR {
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: GitHubLabel[];
    assignee: GitHubUser | null;
    user: GitHubUser | null;
}

interface GitHubPRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    previous_filename?: string;
}

function mapFileStatus(status: string): ChangedFile["status"] {
    switch (status) {
        case "added":
            return "added";
        case "removed":
            return "removed";
        case "renamed":
            return "renamed";
        default:
            return "modified";
    }
}
