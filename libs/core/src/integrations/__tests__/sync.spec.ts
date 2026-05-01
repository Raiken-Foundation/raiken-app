import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock the heavy dependencies (TicketAnalyzer + the three providers
// + branch helpers) so this stays a unit test of the orchestration logic
// in `sync.ts`. The provider/analyzer shapes are pinned by their own
// dedicated specs.
//
// `vi.mock` calls must run before the module-under-test is imported,
// hence the dynamic import inside each test.

// Mocks must be hoisted so they're set up before the dynamic imports
// of `../sync` inside each test. We expose the per-instance method mocks
// via singleton objects so each test can program their return values.
const mocks = vi.hoisted(() => ({
    branchParser: {
        getCurrentBranch: vi.fn(),
        getGitRemoteInfo: vi.fn(),
        parseTicketFromBranch: vi.fn(),
    },
    gh: {
        getTicket: vi.fn(),
        getMyTickets: vi.fn(),
        getChangedFiles: vi.fn(),
        isConfigured: vi.fn(),
        hasToken: vi.fn(),
        setRepo: vi.fn(),
        name: "github" as const,
    },
    jira: {
        getTicket: vi.fn(),
        getMyTickets: vi.fn(),
        getChangedFiles: vi.fn(),
        isConfigured: vi.fn(),
        name: "jira" as const,
    },
    linear: {
        getTicket: vi.fn(),
        getMyTickets: vi.fn(),
        getChangedFiles: vi.fn(),
        isConfigured: vi.fn(),
        name: "linear" as const,
    },
    analyzer: {
        analyze: vi.fn(),
    },
}));

vi.mock("../branch-parser", () => mocks.branchParser);

// The orchestrator does `new TicketAnalyzer(...)` etc., so the exports
// must be `new`-able. Arrow functions throw "is not a constructor"; we
// use `function` declarations + `Object.assign(this, ...)` so the new
// instance is observably the same singleton each time.
vi.mock("../ticket-analyzer", () => ({
    TicketAnalyzer: function MockAnalyzer(this: object) {
        Object.assign(this, mocks.analyzer);
    },
}));

vi.mock("../github-provider", () => ({
    GitHubProvider: function MockGH(this: object) {
        Object.assign(this, mocks.gh);
    },
}));

vi.mock("../jira-provider", () => ({
    JiraProvider: function MockJira(this: object) {
        Object.assign(this, mocks.jira);
    },
}));

vi.mock("../linear-provider", () => ({
    LinearProvider: function MockLinear(this: object) {
        Object.assign(this, mocks.linear);
    },
}));

const branchParserMocks = mocks.branchParser;
const ghMethods = mocks.gh;
const jiraMethods = mocks.jira;
const linearMethods = mocks.linear;

const STUB_TICKET = {
    id: "42",
    title: "Test ticket",
    description: "",
    labels: [],
    status: "open",
    url: "https://github.com/o/r/pull/42",
    provider: "github" as const,
};

beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
    vi.clearAllMocks();
    branchParserMocks.getCurrentBranch.mockReturnValue("feat/RAI-123-thing");
    branchParserMocks.getGitRemoteInfo.mockReturnValue({ owner: "o", repo: "r" });
    branchParserMocks.parseTicketFromBranch.mockReturnValue(null);
    ghMethods.isConfigured.mockReturnValue(true);
    ghMethods.hasToken.mockReturnValue(true);
    ghMethods.getTicket.mockResolvedValue(STUB_TICKET);
    ghMethods.getMyTickets.mockResolvedValue([]);
    mocks.analyzer.analyze.mockResolvedValue({
        ticket: { id: "stub" },
        affectedSourceFiles: [],
        affectedTestFiles: [],
        summary: "stub summary",
        suggestions: [],
        analyzedAt: "2026-01-01T00:00:00.000Z",
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("syncCurrentTicket — happy paths", () => {
    it("uses the explicit --ticket override and reports source: 'manual'", async () => {
        const { syncCurrentTicket } = await import("../sync");
        ghMethods.getTicket.mockResolvedValue({ ...STUB_TICKET, id: "555" });

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            ticketId: "555",
            config: { provider: "github", github: { token: "t", owner: "o", repo: "r" } },
        });

        expect(ghMethods.getTicket).toHaveBeenCalledWith("555");
        expect(result.source).toBe("manual");
        expect(result.ticket?.id).toBe("555");
        expect(result.impact?.summary).toBe("stub summary");
        expect(result.branchName).toBe("feat/RAI-123-thing");
    });

    it("parses the branch name when no --ticket override is given", async () => {
        const { syncCurrentTicket } = await import("../sync");
        branchParserMocks.parseTicketFromBranch.mockReturnValue({
            ticketId: "123",
            provider: "github",
            branchName: "feat/RAI-123-thing",
        });

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "github", github: { token: "t", owner: "o", repo: "r" } },
        });

        expect(ghMethods.getTicket).toHaveBeenCalledWith("123");
        expect(result.source).toBe("branch");
        expect(result.ticket).toMatchObject({ id: "42" });
    });

    it("falls back to the open-PR-for-branch heuristic when the branch name has no ticket", async () => {
        const { syncCurrentTicket } = await import("../sync");
        // Branch parsing finds nothing.
        branchParserMocks.parseTicketFromBranch.mockReturnValue(null);
        // But the user has an open PR — getMyTickets returns one.
        const prTicket = {
            ...STUB_TICKET,
            id: "77",
            changedFiles: [
                { path: "src/x.ts", status: "modified" as const, additions: 1, deletions: 0 },
            ],
        };
        ghMethods.getMyTickets.mockResolvedValue([prTicket]);

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "github", github: { token: "t", owner: "o", repo: "r" } },
        });

        expect(result.source).toBe("pr");
        expect(result.ticket?.id).toBe("77");
    });
});

describe("syncCurrentTicket — failure / no-config paths", () => {
    it("returns an empty SyncResult (no throw) and warns about owner/repo when neither config nor git remote provide them", async () => {
        const { syncCurrentTicket } = await import("../sync");
        // No owner/repo in config, no git remote either.
        ghMethods.isConfigured.mockReturnValue(false);
        branchParserMocks.getGitRemoteInfo.mockReturnValue(null);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "github" },
        });

        expect(result.ticket).toBeNull();
        expect(result.impact).toBeNull();
        expect(result.branchName).toBe("feat/RAI-123-thing");
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/missing owner\/repo/i),
        );
    });

    it("emits a soft warning (but still returns a working provider) when owner/repo are set but no token is available", async () => {
        const { syncCurrentTicket } = await import("../sync");
        // Configured (owner+repo present) but no token.
        ghMethods.isConfigured.mockReturnValue(true);
        ghMethods.hasToken.mockReturnValue(false);
        branchParserMocks.parseTicketFromBranch.mockReturnValue({
            ticketId: "1",
            provider: "github",
            branchName: "feat/RAI-123-thing",
        });

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "github", github: { owner: "o", repo: "r" } },
        });

        // Provider was returned and used — anonymous mode works.
        expect(ghMethods.getTicket).toHaveBeenCalledWith("1");
        expect(result.ticket).not.toBeNull();
        // …but the user got a heads-up about the rate limit.
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/Anonymous mode active/i),
        );
    });

    it("infers owner/repo from the git remote when the user only set a token", async () => {
        const { syncCurrentTicket } = await import("../sync");
        // First call (constructor): not configured, owner/repo missing.
        // Second call (after setRepo): configured.
        ghMethods.isConfigured
            .mockReturnValueOnce(false)
            .mockReturnValue(true);
        branchParserMocks.getGitRemoteInfo.mockReturnValue({
            owner: "remote-owner",
            repo: "remote-repo",
        });
        branchParserMocks.parseTicketFromBranch.mockReturnValue({
            ticketId: "1",
            provider: "github",
            branchName: "feat/RAI-123-thing",
        });

        await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "github", github: { token: "t" } },
        });

        expect(ghMethods.setRepo).toHaveBeenCalledWith("remote-owner", "remote-repo");
        expect(ghMethods.getTicket).toHaveBeenCalledWith("1");
    });

    it("returns an empty result (no throw) when the ticket fetch fails", async () => {
        const { syncCurrentTicket } = await import("../sync");
        ghMethods.getTicket.mockRejectedValue(new Error("github 502"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            ticketId: "999",
            config: { provider: "github", github: { token: "t", owner: "o", repo: "r" } },
        });

        expect(result.ticket).toBeNull();
        expect(result.impact).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/Failed to fetch ticket 999/),
            expect.any(String),
        );
    });

    it("warns and returns null when an unknown provider is configured", async () => {
        const { syncCurrentTicket } = await import("../sync");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            // @ts-expect-error — intentional invalid provider for the
            // validation path. Real users hit this when they typo the
            // raiken.config.json `integrations.provider` field.
            config: { provider: "bitbucket" },
        });

        expect(result.ticket).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/Unknown provider/),
        );
    });
});

describe("syncCurrentTicket — provider routing", () => {
    it("routes to JiraProvider when config.provider === 'jira'", async () => {
        const { syncCurrentTicket } = await import("../sync");
        jiraMethods.isConfigured.mockReturnValue(true);
        jiraMethods.getTicket.mockResolvedValue({
            ...STUB_TICKET,
            provider: "jira",
            id: "RAI-1",
        });
        branchParserMocks.parseTicketFromBranch.mockReturnValue({
            ticketId: "RAI-1",
            provider: "jira",
            branchName: "feat/RAI-1",
        });

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: {
                provider: "jira",
                jira: { host: "x.atlassian.net", email: "a@b.c", apiToken: "t" },
            },
        });

        expect(jiraMethods.getTicket).toHaveBeenCalledWith("RAI-1");
        expect(ghMethods.getTicket).not.toHaveBeenCalled();
        expect(result.ticket?.id).toBe("RAI-1");
    });

    it("routes to LinearProvider when config.provider === 'linear'", async () => {
        const { syncCurrentTicket } = await import("../sync");
        linearMethods.isConfigured.mockReturnValue(true);
        linearMethods.getTicket.mockResolvedValue({
            ...STUB_TICKET,
            provider: "linear",
            id: "ENG-9",
        });
        branchParserMocks.parseTicketFromBranch.mockReturnValue({
            ticketId: "ENG-9",
            provider: "linear",
            branchName: "feat/ENG-9",
        });

        const result = await syncCurrentTicket({
            projectPath: "/fake/project",
            config: { provider: "linear", linear: { apiKey: "k" } },
        });

        expect(linearMethods.getTicket).toHaveBeenCalledWith("ENG-9");
        expect(result.ticket?.id).toBe("ENG-9");
    });
});
