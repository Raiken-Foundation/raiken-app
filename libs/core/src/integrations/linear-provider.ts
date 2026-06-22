/**
 * Linear ticket provider.
 *
 * Uses the Linear GraphQL API to fetch issues.
 *
 * Auth: LINEAR_API_KEY env var or config value.
 */

import type { ChangedFile, IntegrationConfig, TicketInfo, TicketProvider } from "./types";

const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export class LinearProvider implements TicketProvider {
    readonly name = "linear" as const;
    private apiKey: string;
    private teamKey: string;

    constructor(config?: IntegrationConfig["linear"]) {
        this.apiKey = config?.apiKey || process.env["LINEAR_API_KEY"] || "";
        this.teamKey = config?.teamKey || "";
    }

    isConfigured(): boolean {
        return !!this.apiKey;
    }

    async getTicket(ticketId: string): Promise<TicketInfo> {
        const query = `
            query GetIssue($id: String!) {
                issue(id: $id) {
                    id
                    identifier
                    title
                    description
                    url
                    state { name }
                    assignee { name email }
                    labels { nodes { name } }
                }
            }
        `;

        // Linear accepts both UUID and identifier (e.g. ENG-123)
        let data = await this.graphql<{ issue: LinearIssue | null }>(query, { id: ticketId });

        if (!data.issue) {
            // Try searching by identifier
            const searchQuery = `
                query SearchIssue($filter: IssueFilter) {
                    issues(filter: $filter, first: 1) {
                        nodes {
                            id
                            identifier
                            title
                            description
                            url
                            state { name }
                            assignee { name email }
                            labels { nodes { name } }
                        }
                    }
                }
            `;

            const searchData = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(
                searchQuery,
                { filter: { identifier: { eq: ticketId } } },
            );

            if (searchData.issues.nodes.length === 0) {
                throw new Error(`Linear issue "${ticketId}" not found`);
            }

            data = { issue: searchData.issues.nodes[0] };
        }

        return this.mapIssue(data.issue!);
    }

    async getMyTickets(): Promise<TicketInfo[]> {
        const teamFilter = this.teamKey ? `, team: { key: { eq: "${this.teamKey}" } }` : "";

        const query = `
            query MyIssues {
                viewer {
                    assignedIssues(
                        filter: {
                            state: { type: { nin: ["completed", "canceled"] } }
                            ${teamFilter}
                        }
                        first: 20
                        orderBy: updatedAt
                    ) {
                        nodes {
                            id
                            identifier
                            title
                            description
                            url
                            state { name }
                            assignee { name email }
                            labels { nodes { name } }
                        }
                    }
                }
            }
        `;

        const data = await this.graphql<{
            viewer: { assignedIssues: { nodes: LinearIssue[] } };
        }>(query, {});

        return data.viewer.assignedIssues.nodes.map((issue) => this.mapIssue(issue));
    }

    async getChangedFiles(_ticketId: string): Promise<ChangedFile[]> {
        // Linear doesn't track file changes. PRs linked via
        // GitHub integration could be queried, but that requires
        // the GitHub provider. Return empty.
        return [];
    }

    // =========================================================================
    // Internals
    // =========================================================================

    private mapIssue(issue: LinearIssue): TicketInfo {
        return {
            id: issue.identifier,
            title: issue.title,
            description: issue.description || "",
            labels: issue.labels?.nodes?.map((l) => l.name) || [],
            assignee: issue.assignee?.name || issue.assignee?.email,
            status: issue.state?.name || "unknown",
            url: issue.url,
            provider: "linear",
        };
    }

    private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const response = await fetch(GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
                Authorization: this.apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, variables }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Linear API error ${response.status}: ${response.statusText}. ${body}`);
        }

        const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

        if (json.errors && json.errors.length > 0) {
            throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
        }

        if (!json.data) {
            throw new Error("Linear API returned no data");
        }

        return json.data;
    }
}

// =========================================================================
// Linear API response types (minimal)
// =========================================================================

interface LinearIssue {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    state: { name: string } | null;
    assignee: { name?: string; email?: string } | null;
    labels: { nodes: Array<{ name: string }> } | null;
}
