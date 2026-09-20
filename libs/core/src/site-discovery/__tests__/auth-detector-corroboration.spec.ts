import { describe, expect, it } from "vitest";

/**
 * Pins the detector corroboration contract (review finding,
 * detectors/auth.ts:321-343): a password field on a NON-login URL is not an
 * auth wall by itself — a settings/change-password page on a signed-in
 * crawl, or any public page with a password input, must not be misfiled as
 * an auth route or pause the crawl. Corroboration (login-shaped URL, a
 * known submit control, or an explicit auth-error message) is required.
 */

const detect = async (url: string, pageFake: unknown) => {
    const auth = await import("../detectors/auth");
    return auth.detectAuth({
        page: pageFake as never,
        url,
        response: null,
    } as never);
};

const pageWith = (options: {
    passwordFields?: number;
    submit?: string | null;
    visibleError?: string | null;
}) => ({
    locator: (selector: string) => ({
        first() {
            const matches =
                selector === 'input[type="password"]'
                    ? (options.passwordFields ?? 1)
                    : options.submit === selector
                      ? 1
                      : 0;
            return {
                count: async () => matches,
                isVisible: async () => true,
                boundingBox: async () => ({ width: 100, height: 30, x: 0, y: 0 }),
            };
        },
        async count() {
            if (selector === 'input[type="password"]') return options.passwordFields ?? 1;
            return options.submit && selector === options.submit ? 1 : 0;
        },
    }),
    content: async () => "",
    evaluate: async () =>
        options.visibleError ? { bodyText: options.visibleError } : { bodyText: "" },
    url: async () => "https://app.example/settings/password",
});

describe("auth detector login-form corroboration", () => {
    it("does not treat a lone password field on a settings page as an auth wall", async () => {
        // Non-login URL, no submit control matched, no auth-error copy.
        const blocker = await detect(
            "https://app.example/settings/password",
            pageWith({ passwordFields: 1, submit: null }),
        );
        expect(blocker).toBeNull();
    });

    it("still fires on a login-shaped URL regardless of the submit control", async () => {
        const blocker = await detect(
            "https://app.example/login",
            pageWith({ passwordFields: 1, submit: null }),
        );
        expect(blocker).not.toBeNull();
    });

    it("fires off-login when a real submit control corroborates the form", async () => {
        const blocker = await detect(
            "https://app.example/settings/password",
            pageWith({ passwordFields: 1, submit: 'button[type="submit"]' }),
        );
        expect(blocker).not.toBeNull();
    });
});
