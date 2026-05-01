/**
 * Shared types for the ticket integration system.
 *
 * Provider-agnostic interfaces that all ticket sources
 * (GitHub, Jira, Linear) implement.
 */

export interface TicketInfo {
    /** Provider-specific ticket ID (e.g. "42", "RAI-123", "ENG-89") */
    id: string;
    /** Full ticket title */
    title: string;
    /** Ticket body / description (may be markdown) */
    description: string;
    /** Labels / tags attached to the ticket */
    labels: string[];
    /** The user assigned to this ticket */
    assignee?: string;
    /** Current status (open, in_progress, closed, etc.) */
    status: string;
    /** URL to the ticket in the provider's UI */
    url: string;
    /** Which provider this came from */
    provider: "github" | "jira" | "linear";
    /** For PRs: files changed in the diff */
    changedFiles?: ChangedFile[];
    /** For PRs/issues: linked issue IDs */
    linkedTickets?: string[];
}

export interface ChangedFile {
    path: string;
    status: "added" | "modified" | "removed" | "renamed";
    additions: number;
    deletions: number;
    /** Only present for renames */
    previousPath?: string;
}

export interface TicketImpactReason {
    reason: "source_map" | "imports" | "calls" | "renders" | "runtime" | "name_match" | "semantic";
    provenance: "manual" | "static_ast" | "runtime" | "inferred";
    confidence: number;
    line?: number;
    snippet?: string;
    sourceSymbol?: string;
    targetSymbol?: string;
}

export interface TicketImpact {
    /** The ticket that was analyzed */
    ticket: TicketInfo;
    /** Source files in the project that are likely affected */
    affectedSourceFiles: string[];
    /** Test files that cover the affected source files */
    affectedTestFiles: Array<{
        testFile: string;
        reason: "source_map" | "dependency" | "semantic";
        sourceFile: string;
        /** Aggregated 0..1 confidence score */
        confidence?: number;
        /** All evidence rows that contributed to this match. */
        evidence?: TicketImpactReason[];
    }>;
    /** Symbols within affected files that are most likely to need attention. */
    affectedSymbols?: Array<{
        file: string;
        name: string;
        kind: string;
        startLine: number;
        endLine: number;
        confidence: number;
    }>;
    /** LLM-generated summary of what the ticket means for tests */
    summary: string;
    /** Suggested actions */
    suggestions: TicketSuggestion[];
    /** Timestamp of the analysis */
    analyzedAt: string;
}

export type SuggestionAction = "update_test" | "create_test" | "review_test" | "no_action";

export interface TicketSuggestion {
    action: SuggestionAction;
    testFile?: string;
    reason: string;
    /** If action is create_test, a suggested prompt for the agent */
    suggestedPrompt?: string;
}

export interface TicketProvider {
    readonly name: "github" | "jira" | "linear";

    /**
     * Fetch a single ticket by ID.
     * For GitHub, this handles both issues and PRs.
     */
    getTicket(ticketId: string): Promise<TicketInfo>;

    /**
     * Get tickets assigned to the current user.
     * Returns only open/in-progress tickets.
     */
    getMyTickets(): Promise<TicketInfo[]>;

    /**
     * For a PR, get the list of changed files.
     */
    getChangedFiles(ticketId: string): Promise<ChangedFile[]>;

    /**
     * Check if the provider is configured and reachable.
     */
    isConfigured(): boolean;
}

export interface IntegrationConfig {
    provider?: "github" | "jira" | "linear";
    github?: {
        /** Personal access token (prefer env var GITHUB_TOKEN) */
        token?: string;
        /** Repository owner */
        owner?: string;
        /** Repository name */
        repo?: string;
    };
    jira?: {
        host?: string;
        email?: string;
        apiToken?: string;
        projectKey?: string;
    };
    linear?: {
        apiKey?: string;
        teamKey?: string;
    };
    /** Branch name patterns for ticket ID extraction */
    branchPatterns?: string[];
}

export interface SyncResult {
    ticket: TicketInfo | null;
    impact: TicketImpact | null;
    source: "branch" | "pr" | "manual";
    branchName: string;
    timestamp: string;
}
