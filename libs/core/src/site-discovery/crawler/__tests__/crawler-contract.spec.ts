import { describe, expect, it } from "vitest";

import {
    createAuthDetector,
    createManualFallbackDetector,
    runBlockerPipeline,
} from "../../detectors";

describe("request handler blocker ordering contract", () => {
    it("runs manual-fallback before auth so consent wins over auth on same page", async () => {
        const manual = createManualFallbackDetector();
        const auth = createAuthDetector();
        const order: string[] = [];
        const wrappedManual = {
            ...manual,
            async detect(ctx: Parameters<typeof manual.detect>[0]) {
                order.push("manual");
                return manual.detect(ctx);
            },
        };
        const wrappedAuth = {
            ...auth,
            async detect(ctx: Parameters<typeof auth.detect>[0]) {
                order.push("auth");
                return auth.detect(ctx);
            },
        };

        const page = {
            content: async () =>
                `<html><body>
                    <form><input name="password" type="password"/></form>
                    <iframe src="https://challenges.cloudflare.com/turnstile"></iframe>
                </body></html>`,
            locator: () => ({
                count: async () => 0,
                first: () => ({ count: async () => 0 }),
            }),
        } as never;

        await runBlockerPipeline([wrappedManual, wrappedAuth], {
            projectPath: "/p",
            url: "http://localhost/login",
            page,
        });

        expect(order[0]).toBe("manual");
    });
});

describe("runtime setup contract", () => {
    it("computes handler timeout as a multiple of navigation timeout", async () => {
        const { computeHandlerTimeouts, computeCrawleeRequestCap } = await import(
            "../runtime-setup"
        );
        const { navTimeoutSecs, handlerTimeoutSecs } = computeHandlerTimeouts(30_000);
        expect(navTimeoutSecs).toBe(30);
        expect(handlerTimeoutSecs).toBeGreaterThanOrEqual(60);
        expect(computeCrawleeRequestCap(100)).toBe(150);
        expect(computeCrawleeRequestCap(5)).toBe(15);
    });
});

describe("failed request handler events contract", () => {
    it("summarises navigation failures for warning emission", async () => {
        const { summariseNavigationFailure } = await import("../failure-summary");
        expect(summariseNavigationFailure(undefined, 404)).toBe("HTTP 404");
        expect(summariseNavigationFailure(new Error("Timeout 30000ms exceeded"), null)).toBe(
            "Navigation timeout",
        );
    });
});
