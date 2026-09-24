import { describe, expect, it } from "vitest";
import { resolveCoverAuthPrecondition, shouldUseStorageState } from "../agent/graph/utils";

/**
 * `raiken cover` is one-shot: it has no graph node to refine a coarse first
 * auth guess, so its classifier must default to `authenticated` and only
 * honour unambiguous login / logged-out signals. The "stays authenticated"
 * rows are the regression guard: these scenarios describe *signed-in* actions
 * that merely mention auth-adjacent nouns, and classifying them as login_flow
 * would strip storageState from tests that must start authenticated.
 */
describe("resolveCoverAuthPrecondition", () => {
    const cases: Array<{
        prompt: string;
        expected: "authenticated" | "unauthenticated" | "login_flow";
    }> = [
        // Unambiguous login flows → no storageState.
        { prompt: "test the MFA verification code prompt for mfa-admin", expected: "login_flow" },
        {
            prompt: "log in as mfa-admin: wrong code first, then correct code 123456 reaches the dashboard",
            expected: "login_flow",
        },
        { prompt: "test signing in with invalid credentials", expected: "login_flow" },
        // Unambiguous logged-out goals → no storageState.
        { prompt: "verify the login page renders while logged out", expected: "unauthenticated" },
        { prompt: "check the unauthenticated landing experience", expected: "unauthenticated" },
        // Signed-in actions that merely mention auth words → MUST stay authenticated.
        { prompt: "verify the session details on the dashboard", expected: "authenticated" },
        {
            prompt: "verify the auth guard redirects signed-in users away from /login",
            expected: "authenticated",
        },
        { prompt: "verify the member can manage the session", expected: "authenticated" },
        { prompt: "test the logout button", expected: "authenticated" },
        // Ordinary non-auth scenarios → default authenticated.
        { prompt: "create a new support ticket and verify it appears", expected: "authenticated" },
        {
            prompt: "add a product to the cart, apply WELCOME10, then checkout and verify the total",
            expected: "authenticated",
        },
        {
            prompt: "delete the workspace from settings as an admin",
            expected: "authenticated",
        },
    ];

    for (const { prompt, expected } of cases) {
        it(`classifies "${prompt.slice(0, 60)}" as ${expected}`, () => {
            const precondition = resolveCoverAuthPrecondition(prompt);
            expect(precondition).toBe(expected);
            expect(shouldUseStorageState(precondition)).toBe(expected === "authenticated");
        });
    }
});
