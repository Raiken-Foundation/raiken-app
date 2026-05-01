import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider } from "../github-provider";

// We stub `globalThis.fetch` rather than using `msw` or undici mocking
// because the provider uses the platform `fetch` directly. Each test
// asserts BOTH the network call shape (URL, headers, method) and the
// shape of the returned `TicketInfo` so a regression in either layer
// fails fast.

interface FetchCall {
    url: string;
    init?: RequestInit;
}

interface MockResponse {
    status?: number;
    statusText?: string;
    body: unknown;
}

function installFetchMock(responses: MockResponse[]): {
    calls: FetchCall[];
    restore: () => void;
} {
    const calls: FetchCall[] = [];
    let i = 0;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: typeof url === "string" ? url : url.toString(),
            init,
        });
        const r = responses[i++] ?? {
            status: 500,
            statusText: "no more mocked responses",
            body: { error: "exhausted" },
        };
        return new Response(JSON.stringify(r.body), {
            status: r.status ?? 200,
            statusText: r.statusText ?? "OK",
            headers: { "content-type": "application/json" },
        });
    }) as typeof globalThis.fetch;
    return {
        calls,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

let mock: ReturnType<typeof installFetchMock> | null = null;

afterEach(() => {
    mock?.restore();
    mock = null;
    vi.restoreAllMocks();
});

describe("GitHubProvider — configuration", () => {
    beforeEach(() => {
        delete process.env["GITHUB_TOKEN"];
    });

    // Bug fix recorded as a test: `isConfigured()` used to require a
    // token, which locked all public-repo querying behind a token even
    // though GitHub's API allows anonymous reads. The new contract is
    // owner+repo only; token presence is a separate concern surfaced
    // via `hasToken()`.
    it("isConfigured returns true with owner+repo even when no token is set (public-repo anonymous mode)", () => {
        const gh = new GitHubProvider({ owner: "o", repo: "r" });
        expect(gh.isConfigured()).toBe(true);
        expect(gh.hasToken()).toBe(false);
    });

    it("isConfigured returns false when owner is missing", () => {
        const gh = new GitHubProvider({ token: "t", repo: "r" });
        expect(gh.isConfigured()).toBe(false);
    });

    it("isConfigured returns false when repo is missing", () => {
        const gh = new GitHubProvider({ token: "t", owner: "o" });
        expect(gh.isConfigured()).toBe(false);
    });

    it("hasToken reflects either env var or config-supplied token", () => {
        const fromConfig = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        expect(fromConfig.hasToken()).toBe(true);

        process.env["GITHUB_TOKEN"] = "env-token";
        const fromEnv = new GitHubProvider({ owner: "o", repo: "r" });
        expect(fromEnv.hasToken()).toBe(true);
    });

    it("setRepo updates owner+repo at runtime (used by sync.ts when inferring from git remote)", () => {
        const gh = new GitHubProvider({ token: "t" });
        expect(gh.isConfigured()).toBe(false);
        gh.setRepo("acme", "widgets");
        expect(gh.isConfigured()).toBe(true);
    });
});

describe("GitHubProvider — getTicket", () => {
    beforeEach(() => {
        delete process.env["GITHUB_TOKEN"];
    });

    it("rejects non-numeric ticket IDs without hitting the network", async () => {
        mock = installFetchMock([]);
        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        await expect(gh.getTicket("RAI-123")).rejects.toThrow(/Invalid GitHub ticket ID/);
        expect(mock.calls.length).toBe(0);
    });

    it("returns a TicketInfo built from a PR (preferred over issue)", async () => {
        mock = installFetchMock([
            // /pulls/42 → success
            {
                body: {
                    number: 42,
                    title: "Add login page",
                    body: "Closes #41",
                    state: "open",
                    html_url: "https://github.com/o/r/pull/42",
                    labels: [{ name: "frontend" }, { name: "feature" }],
                    assignee: { login: "alice" },
                    user: { login: "bob" },
                },
            },
            // /pulls/42/files → 1 modified file
            {
                body: [
                    {
                        filename: "src/login.tsx",
                        status: "modified",
                        additions: 50,
                        deletions: 5,
                    },
                ],
            },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const ticket = await gh.getTicket("42");

        expect(ticket).toMatchObject({
            id: "42",
            title: "Add login page",
            description: "Closes #41",
            labels: ["frontend", "feature"],
            assignee: "alice",
            status: "open",
            url: "https://github.com/o/r/pull/42",
            provider: "github",
        });
        expect(ticket.changedFiles).toEqual([
            {
                path: "src/login.tsx",
                status: "modified",
                additions: 50,
                deletions: 5,
                previousPath: undefined,
            },
        ]);
        expect(ticket.linkedTickets).toEqual(["41"]);

        // Verify we sent the bearer token header
        expect(mock.calls[0].url).toBe(
            "https://api.github.com/repos/o/r/pulls/42",
        );
        const headers = mock.calls[0].init?.headers as Record<string, string> | undefined;
        expect(headers?.["Authorization"]).toBe("Bearer t");
        expect(headers?.["Accept"]).toBe("application/vnd.github+json");
        expect(headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
    });

    it("falls back to /issues/N when /pulls/N 404s", async () => {
        mock = installFetchMock([
            // /pulls/42 → 404 (it's an issue, not a PR)
            { status: 404, body: { message: "Not Found" } },
            // /issues/42 → success
            {
                body: {
                    number: 42,
                    title: "Bug: button broken",
                    body: "Steps to reproduce",
                    state: "open",
                    html_url: "https://github.com/o/r/issues/42",
                    labels: ["bug"],
                    assignee: { login: "carol" },
                    pull_request: undefined,
                },
            },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const ticket = await gh.getTicket("42");

        expect(ticket.id).toBe("42");
        expect(ticket.title).toBe("Bug: button broken");
        // Issue, not PR → no changedFiles array.
        expect(ticket.changedFiles).toBeUndefined();
        expect(ticket.url).toContain("/issues/42");
    });

    it("treats string-typed labels (legacy issues API) the same as object labels", async () => {
        mock = installFetchMock([
            { status: 404, body: { message: "Not Found" } }, // /pulls
            {
                body: {
                    number: 7,
                    title: "x",
                    body: "",
                    state: "open",
                    html_url: "https://github.com/o/r/issues/7",
                    // GitHub sometimes returns labels as bare strings on
                    // older API responses. The provider must handle both.
                    labels: ["bug", { name: "p1" }],
                    assignee: null,
                },
            },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const ticket = await gh.getTicket("7");
        expect(ticket.labels).toEqual(["bug", "p1"]);
    });

    it("re-routes to fetchPR when /issues/N reports the issue is actually a PR", async () => {
        mock = installFetchMock([
            // /pulls/9 → 404 (we're hitting it first by default)
            { status: 404, body: { message: "Not Found" } },
            // /issues/9 → returns an issue with `pull_request` set
            // (means it's a PR after all, just routed via the issues
            // endpoint). The provider should re-fetch via /pulls.
            {
                body: {
                    number: 9,
                    title: "issue-shaped PR",
                    body: "",
                    state: "open",
                    html_url: "https://github.com/o/r/pull/9",
                    labels: [],
                    assignee: null,
                    pull_request: { url: "..." },
                },
            },
            // /pulls/9 again
            {
                body: {
                    number: 9,
                    title: "PR proper",
                    body: "",
                    state: "open",
                    html_url: "https://github.com/o/r/pull/9",
                    labels: [],
                    assignee: null,
                    user: null,
                },
            },
            // /pulls/9/files
            { body: [] },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const ticket = await gh.getTicket("9");
        expect(ticket.title).toBe("PR proper");
        expect(ticket.changedFiles).toEqual([]);
    });

    it("throws a useful error when both PR and issue lookups fail", async () => {
        mock = installFetchMock([
            { status: 404, body: { message: "Not Found" } },
            { status: 404, body: { message: "Not Found" } },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        await expect(gh.getTicket("999")).rejects.toThrow(
            /not found in o\/r/,
        );
    });
});

describe("GitHubProvider — getChangedFiles", () => {
    it("maps PR file statuses to our union type", async () => {
        mock = installFetchMock([
            {
                body: [
                    { filename: "a.ts", status: "added", additions: 10, deletions: 0 },
                    { filename: "b.ts", status: "removed", additions: 0, deletions: 30 },
                    { filename: "c.ts", status: "renamed", additions: 0, deletions: 0, previous_filename: "old-c.ts" },
                    { filename: "d.ts", status: "modified", additions: 3, deletions: 1 },
                    // Anything we don't recognise should default to "modified".
                    { filename: "e.ts", status: "weird-future-status", additions: 0, deletions: 0 },
                ],
            },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const files = await gh.getChangedFiles("123");

        expect(files.map((f) => [f.path, f.status])).toEqual([
            ["a.ts", "added"],
            ["b.ts", "removed"],
            ["c.ts", "renamed"],
            ["d.ts", "modified"],
            ["e.ts", "modified"],
        ]);
        expect(files[2].previousPath).toBe("old-c.ts");
    });

    it("returns [] when the API call fails (non-PR ticket, network down, etc)", async () => {
        mock = installFetchMock([
            { status: 404, body: { message: "Not Found" } },
        ]);

        const gh = new GitHubProvider({ token: "t", owner: "o", repo: "r" });
        const files = await gh.getChangedFiles("999");
        expect(files).toEqual([]);
    });
});

describe("GitHubProvider — auth header behaviour", () => {
    it("omits the Authorization header when no token is configured (anonymous mode)", async () => {
        delete process.env["GITHUB_TOKEN"];
        mock = installFetchMock([
            // anonymous fetch of a public PR
            {
                body: {
                    number: 1,
                    title: "Hello",
                    body: "",
                    state: "open",
                    html_url: "https://github.com/o/r/pull/1",
                    labels: [],
                    assignee: null,
                    user: null,
                },
            },
            { body: [] },
        ]);

        const gh = new GitHubProvider({ owner: "o", repo: "r" });
        await gh.getTicket("1");

        const headers = mock.calls[0].init?.headers as Record<string, string> | undefined;
        expect(headers?.["Authorization"]).toBeUndefined();
        // Public requests still need the API version + accept headers.
        expect(headers?.["Accept"]).toBe("application/vnd.github+json");
    });
});
