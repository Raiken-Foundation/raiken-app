/**
 * Auth Detector Tests
 *
 * Drives the auth detector through its public surface (`detectAuth`) and
 * a stub `Page`/`Response`. The previous test reached into private
 * methods on a class; that class is now a thin shim over `detectors/auth.ts`,
 * so we test the module directly.
 */

import { describe, expect, it } from "vitest";

import { detectAuth } from "../detectors/auth";

const PROJECT_PATH = "/test/project";

interface FakeLocator {
    count: () => Promise<number>;
    first: () => FakeLocator;
    textContent?: () => Promise<string | null>;
}

function makePage(opts: {
    content?: string;
    locators?: Record<string, FakeLocator>;
}) {
    const locators = opts.locators ?? {};
    const defaultLocator: FakeLocator = {
        count: async () => 0,
        first() {
            return this;
        },
        textContent: async () => null,
    };
    return {
        content: async () => opts.content ?? "<html><body></body></html>",
        locator(selector: string) {
            return locators[selector] ?? defaultLocator;
        },
    } as unknown as import("playwright").Page;
}

function makeResponse(status: number) {
    return { status: () => status } as unknown as import("playwright").Response;
}

describe("detectAuth", () => {
    it("flags a 401 response as auth_required (http_status)", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/me",
            page: makePage({}),
            response: makeResponse(401),
        });
        expect(blocker?.category).toBe("auth_required");
        expect(blocker?.detectorId).toBe("auth:http_status");
        expect(blocker?.blockerType).toBe("http_status");
    });

    it("flags a 403 response too", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/secret",
            page: makePage({}),
            response: makeResponse(403),
        });
        expect(blocker?.detectorId).toBe("auth:http_status");
    });

    it("ignores 200 responses", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000",
            page: makePage({}),
            response: makeResponse(200),
        });
        expect(blocker).toBeNull();
    });

    it("detects an explicit auth error message in page content", async () => {
        const page = makePage({
            content: "<html><body><div>Please log in to continue.</div></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/dashboard",
            page,
        });
        expect(blocker?.detectorId).toBe("auth:error_message");
    });

    it("does NOT pause on a marketing page that just hosts a 'Sign in with Google' button", async () => {
        // The OAuth check only fires when the URL also looks login-y.
        const page = makePage({
            content: "<html><body><a>Sign in with Google</a></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/marketing",
            page,
        });
        expect(blocker).toBeNull();
    });

    it("DOES pause on a /login page that exposes a 'Sign in with Google' button", async () => {
        const page = makePage({
            content: "<html><body><a>Sign in with Google</a></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/login",
            page,
        });
        expect(blocker?.detectorId).toBe("auth:oauth_button");
    });

    it("detects a login form (password + submit)", async () => {
        const passwordLocator: FakeLocator = {
            count: async () => 1,
            first() {
                return this;
            },
        };
        const submitLocator: FakeLocator = {
            count: async () => 1,
            first() {
                return this;
            },
        };
        const page = makePage({
            content: "<html><body><form><input type='password'/><button type='submit'>Go</button></form></body></html>",
            locators: {
                'input[type="password"]': passwordLocator,
                'button[type="submit"]': submitLocator,
            },
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/dashboard",
            page,
        });
        // No URL pattern match: detector_id should be auth:login_form.
        expect(blocker?.detectorId).toBe("auth:login_form");
    });
});
