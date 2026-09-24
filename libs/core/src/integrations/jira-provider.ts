/**
 * Jira ticket provider.
 *
 * Uses the Jira REST API v3 to fetch issues and their details.
 *
 * Auth: JIRA_API_TOKEN + JIRA_EMAIL env vars, or config values.
 * Host: JIRA_HOST env var or config (e.g. "mycompany.atlassian.net")
 */

import type { ChangedFile, IntegrationConfig, TicketInfo, TicketProvider } from "./types";

export class JiraProvider implements TicketProvider {
    readonly name = "jira" as const;
    private host: string;
    private email: string;
    private apiToken: string;
    private projectKey: string;

    constructor(config?: IntegrationConfig["jira"]) {
        this.host = config?.host || process.env["JIRA_HOST"] || "";
        this.email = config?.email || process.env["JIRA_EMAIL"] || "";
        this.apiToken = config?.apiToken || process.env["JIRA_API_TOKEN"] || "";
        this.projectKey = config?.projectKey || "";
    }

    isConfigured(): boolean {
        return !!this.host && !!this.email && !!this.apiToken;
    }

    async getTicket(ticketId: string): Promise<TicketInfo> {
        const issue = await this.apiFetch<JiraIssue>(`/rest/api/3/issue/${ticketId}`);

        return this.mapIssue(issue);
    }

    async getMyTickets(): Promise<TicketInfo[]> {
        const projectClause = this.projectKey ? ` AND project = "${this.projectKey}"` : "";

        const jql = `assignee = currentUser() AND status != Done${projectClause} ORDER BY updated DESC`;
        const response = await this.apiFetch<JiraSearchResponse>(
            `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=20&fields=summary,description,status,labels,assignee,issuetype`,
        );

        return response.issues.map((issue) => this.mapIssue(issue));
    }

    async getChangedFiles(_ticketId: string): Promise<ChangedFile[]> {
        // Jira doesn't track file changes natively.
        // Dev info (linked commits/PRs) requires the Development panel API
        // which needs additional permissions. Return empty for now.
        return [];
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private mapIssue(issue: JiraIssue): TicketInfo {
        const fields = issue.fields;

        let description = "";
        if (fields.description) {
            description = this.extractTextFromADF(fields.description);
        }

        return {
            id: issue.key,
            title: fields.summary,
            description,
            labels: fields.labels || [],
            assignee: fields.assignee?.displayName || fields.assignee?.emailAddress,
            status: fields.status?.name || "unknown",
            url: `https://${this.host}/browse/${issue.key}`,
            provider: "jira",
        };
    }

    /**
     * Extract plain text from Atlassian Document Format (ADF).
     * ADF is a nested JSON structure; we recursively pull out text nodes.
     */
    private extractTextFromADF(adf: ADFNode): string {
        if (!adf || typeof adf !== "object") return "";

        const parts: string[] = [];

        if (adf.type === "text" && adf.text) {
            parts.push(adf.text);
        }

        if (Array.isArray(adf.content)) {
            for (const child of adf.content) {
                parts.push(this.extractTextFromADF(child));
            }
        }

        return parts.join(adf.type === "paragraph" ? "\n" : " ").trim();
    }

    private async apiFetch<T>(endpoint: string): Promise<T> {
        const url = `https://${this.host}${endpoint}`;

        const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString("base64");

        const response = await fetch(url, {
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Jira API error ${response.status}: ${response.statusText}. ${body}`);
        }

        return response.json() as Promise<T>;
    }
}

// =========================================================================
// Jira API response types (minimal)
// =========================================================================

interface JiraUser {
    displayName?: string;
    emailAddress?: string;
}

interface JiraStatus {
    name: string;
}

interface ADFNode {
    type: string;
    text?: string;
    content?: ADFNode[];
}

interface JiraIssueFields {
    summary: string;
    description: ADFNode | null;
    status: JiraStatus | null;
    labels: string[];
    assignee: JiraUser | null;
    issuetype?: { name: string };
}

interface JiraIssue {
    key: string;
    fields: JiraIssueFields;
}

interface JiraSearchResponse {
    issues: JiraIssue[];
    total: number;
}
