import { describe, expect, it } from "vitest";
import { looksLikeAuthScenario } from "../cover/evidence";

describe("looksLikeAuthScenario", () => {
    const authCases = [
        "sign in with username and password then see the dashboard",
        "log in as admin and delete the workspace",
        "login as admin and see the dashboard",
        "test signing in with invalid credentials",
        "test the login page renders while logged out",
        "reset the password",
        "test the logout button",
        "register a new account",
        "test the MFA verification code prompt",
        "authenticate as an admin and open settings",
        "test the auth guard",
    ];
    const dataCases = [
        "search for 'login' and verify only the login-related card remains",
        "verify the login card appears in the backlog",
        "add a product to the cart and checkout",
        "create a new note with a title and body",
    ];

    for (const text of authCases) {
        it(`treats "${text.slice(0, 55)}" as auth`, () => {
            expect(looksLikeAuthScenario(text)).toBe(true);
        });
    }
    for (const text of dataCases) {
        it(`does not treat "${text.slice(0, 55)}" as auth`, () => {
            expect(looksLikeAuthScenario(text)).toBe(false);
        });
    }
});
