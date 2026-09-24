import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthDetector, createManualFallbackDetector, runBlockerPipeline } from "../detectors";

function loadChromium() {
    try {
        return require("playwright").chromium as typeof import("playwright").chromium | null;
    } catch {
        try {
            return require("playwright-core").chromium as
                | typeof import("playwright").chromium
                | null;
        } catch {
            return null;
        }
    }
}

function pageHtml(blocking: boolean): string {
    const consentStyle = blocking
        ? "position:fixed;inset:0;z-index:10;background:white;display:grid;place-items:center"
        : "position:fixed;left:0;right:0;bottom:0;z-index:10;padding:12px;background:white;pointer-events:none";
    return `<!doctype html>
<html>
    <head><title>Consent over auth</title></head>
    <body>
        <main>
            <h1>Sign in</h1>
            <form>
                <label>Username <input name="username" /></label>
                <label>Password <input name="password" type="password" /></label>
                <button type="submit">Sign in</button>
            </form>
        </main>
        <section role="dialog" aria-label="Cookie preferences" style="${consentStyle}">
            <p>We use cookies to improve your experience.</p>
            <button type="button" style="pointer-events:auto">Accept all</button>
        </section>
    </body>
</html>`;
}

const chromium = loadChromium();
const describeIfBrowser = chromium ? describe : describe.skip;

describeIfBrowser("consent over auth detector integration", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const blocking = req.url?.includes("blocking=true") ?? false;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(pageHtml(blocking));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("lets a reachable login form outrank a non-blocking cookie banner", async () => {
        if (!chromium) return;
        let browser: import("playwright").Browser | null = null;
        try {
            browser = await chromium.launch({ headless: true });
        } catch {
            return;
        }
        const page = await browser.newPage();
        const url = `${baseUrl}/login`;
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });

        const blocker = await runBlockerPipeline(
            [createManualFallbackDetector(), createAuthDetector()],
            {
                projectPath: "/test/project",
                url,
                page,
                response: response ?? undefined,
            },
        );

        expect(blocker?.category).toBe("auth_required");
        expect(blocker?.detectorId).toMatch(/^auth:/);
        await browser.close();
    });

    it("can skip a blocking consent category and reveal the underlying auth wall", async () => {
        if (!chromium) return;
        let browser: import("playwright").Browser | null = null;
        try {
            browser = await chromium.launch({ headless: true });
        } catch {
            return;
        }
        const page = await browser.newPage();
        const url = `${baseUrl}/login?blocking=true`;
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        const detectors = [createManualFallbackDetector(), createAuthDetector()];
        const context = {
            projectPath: "/test/project",
            url,
            page,
            response: response ?? undefined,
        };

        const first = await runBlockerPipeline(detectors, context);
        expect(first?.category).toBe("consent_wall");

        const afterIgnore = await runBlockerPipeline(detectors, context, {
            skipCategories: new Set(["consent_wall"]),
        });
        expect(afterIgnore?.category).toBe("auth_required");

        await browser.close();
    });
});
