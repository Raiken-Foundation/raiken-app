import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTicketFromBranch } from "../branch-parser";

// branch-parser also exports `getCurrentBranch` and `getGitRemoteInfo`,
// but those shell out to the real `git` binary against the surrounding
// repo. We don't exercise them here — they're implicitly covered by the
// live smoke test in tests/integration. Pure regex logic is what's worth
// pinning, because that's where most of the bugs are.

describe("parseTicketFromBranch", () => {
    describe("returns null for unparseable branches", () => {
        it.each([
            "main",
            "develop",
            "feature/no-ticket-here",
            "chore/cleanup",
            "release",
            "",
        ])("returns null for %j", (branch) => {
            expect(parseTicketFromBranch(branch)).toBeNull();
        });
    });

    describe("Jira-style IDs (PROJECT-123)", () => {
        it("parses a Jira ticket from a feat/ branch", () => {
            const result = parseTicketFromBranch("feat/RAI-123-add-login");
            expect(result).toEqual({
                ticketId: "RAI-123",
                provider: "jira",
                branchName: "feat/RAI-123-add-login",
            });
        });

        it("parses a Jira ticket without prefix slashes", () => {
            const result = parseTicketFromBranch("RAI-456");
            expect(result?.ticketId).toBe("RAI-456");
            expect(result?.provider).toBe("jira");
        });

        it("parses Jira ticket with multi-letter project key", () => {
            const result = parseTicketFromBranch("feature/PROJ-100");
            expect(result?.ticketId).toBe("PROJ-100");
            expect(result?.provider).toBe("jira");
        });

        // Bug-pin: Linear and Jira regexes overlap. A 2-5 letter prefix
        // matches BOTH `JIRA_PATTERN` and `LINEAR_PATTERN`. The current
        // resolution order is Jira first, so any short-prefix ID is
        // labelled "jira" even when the user is on Linear. We pin the
        // current behaviour so a future re-ordering is intentional, not
        // accidental.
        it("[behaviour] favours jira over linear when ID could be either (e.g. ENG-89)", () => {
            const result = parseTicketFromBranch("linear/ENG-89-do-stuff");
            expect(result?.ticketId).toBe("ENG-89");
            // NOTE: provider is "jira" here, not "linear", because Jira
            // regex runs first in the fallback chain. Pass an explicit
            // `provider: "linear"` in config to override (see test below).
            expect(result?.provider).toBe("jira");
        });

        it("returns provider:linear when config.provider explicitly forces it", () => {
            const result = parseTicketFromBranch("linear/ENG-89-do-stuff", {
                provider: "linear",
            });
            expect(result?.ticketId).toBe("ENG-89");
            expect(result?.provider).toBe("linear");
        });
    });

    describe("GitHub-style IDs (numeric)", () => {
        it("parses GH-prefix style", () => {
            const result = parseTicketFromBranch("fix/GH-45-broken-cart");
            expect(result?.ticketId).toBe("45");
            expect(result?.provider).toBe("github");
        });

        it("parses GH prefix without dash", () => {
            const result = parseTicketFromBranch("fix/GH45-broken-cart");
            expect(result?.ticketId).toBe("45");
            expect(result?.provider).toBe("github");
        });

        it("parses bare numeric prefix", () => {
            const result = parseTicketFromBranch("45-fix-broken-cart");
            expect(result?.ticketId).toBe("45");
            expect(result?.provider).toBe("github");
        });

        it("parses `issue-N` style", () => {
            const result = parseTicketFromBranch("fix/issue-78");
            expect(result?.ticketId).toBe("78");
            expect(result?.provider).toBe("github");
        });

        it("parses `#N` style", () => {
            const result = parseTicketFromBranch("fix/#42-bug");
            expect(result?.ticketId).toBe("42");
            expect(result?.provider).toBe("github");
        });
    });

    describe("known regex sharp edges", () => {
        // Bug surfaced: any digit that's adjacent to `/`, `-`, or `#` and
        // followed by a word boundary is treated as a github ticket ID.
        // That means `release/cuda-11-fix` extracts `11` as ticket #11
        // even though no real ticket exists. Pin the current behaviour
        // so any future tightening flips this assertion deliberately.
        it("[footgun] extracts a version number adjacent to a dash as a github issue", () => {
            const result = parseTicketFromBranch("release/cuda-11-fix");
            expect(result?.provider).toBe("github");
            expect(result?.ticketId).toBe("11");
        });

        it("does not match `chore/cleanup` (no digits)", () => {
            expect(parseTicketFromBranch("chore/cleanup")).toBeNull();
        });

        it("does not match a branch where digits aren't bounded by `/`, `#`, `-` or start", () => {
            // No leading slash/dash before the digit, so the GH fallback
            // refuses to match.
            const result = parseTicketFromBranch("hotfix1234");
            expect(result).toBeNull();
        });
    });

    describe("custom branchPatterns from config", () => {
        it("uses a custom regex with a single capture group", () => {
            const result = parseTicketFromBranch("dev/T-555/feature", {
                branchPatterns: ["T-(\\d+)"],
            });
            expect(result?.ticketId).toBe("555");
        });

        it("falls through to default patterns when no custom pattern matches", () => {
            const result = parseTicketFromBranch("feat/RAI-123", {
                branchPatterns: ["never-matches-(\\d+)"],
            });
            expect(result?.ticketId).toBe("RAI-123");
        });

        it("silently skips invalid regex patterns", () => {
            // `[unbalanced` is not a valid JS regex — branch parser
            // should swallow the error and try the next pattern instead
            // of throwing.
            expect(() =>
                parseTicketFromBranch("feat/RAI-123", {
                    branchPatterns: ["[unbalanced"],
                }),
            ).not.toThrow();
        });

        it("respects the explicit provider when a custom pattern matches", () => {
            const result = parseTicketFromBranch("dev/T-555/feature", {
                branchPatterns: ["T-(\\d+)"],
                provider: "linear",
            });
            expect(result?.provider).toBe("linear");
        });
    });

    describe("provider scoping", () => {
        it("when provider:github is set, ignores Jira-style IDs in the branch", () => {
            const result = parseTicketFromBranch("feat/RAI-123-thing", {
                provider: "github",
            });
            // RAI-123 is Jira-shaped, but provider is locked to github,
            // so the Jira regex is skipped. The numeric `123` IS picked
            // up by the GitHub fallback though.
            expect(result?.provider).toBe("github");
            expect(result?.ticketId).toBe("123");
        });

        it("when provider:jira is set, never matches a bare-numeric branch", () => {
            const result = parseTicketFromBranch("45-fix", { provider: "jira" });
            expect(result).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// getCurrentBranch / getGitRemoteInfo
//
// These shell out to the real git binary. We can't fully unit-test them
// without a real repo, but we can confirm the "no git, no crash" path.
// ---------------------------------------------------------------------------

describe("getCurrentBranch (failure paths only)", () => {
    let restoreCwd: () => void;

    beforeEach(() => {
        const original = process.cwd();
        restoreCwd = () => process.chdir(original);
    });

    afterEach(() => {
        restoreCwd();
        vi.restoreAllMocks();
    });

    it("returns null when run outside a git repo", async () => {
        const { getCurrentBranch } = await import("../branch-parser");
        // /tmp is virtually guaranteed not to be a git repo.
        expect(getCurrentBranch("/tmp")).toBeNull();
    });

    it("returns null when execSync throws (e.g. git not installed)", async () => {
        const { getCurrentBranch } = await import("../branch-parser");
        // A path that's guaranteed not to exist short-circuits the call.
        expect(getCurrentBranch("/this/path/definitely/does/not/exist")).toBeNull();
    });
});

describe("getGitRemoteInfo (failure paths only)", () => {
    it("returns null when there's no git remote", async () => {
        const { getGitRemoteInfo } = await import("../branch-parser");
        expect(getGitRemoteInfo("/tmp")).toBeNull();
    });
});
