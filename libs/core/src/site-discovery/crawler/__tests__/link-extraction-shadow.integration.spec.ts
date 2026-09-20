import { describe, expect, it } from "vitest";

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

const chromium = loadChromium();
const describeIfBrowser = chromium ? describe : describe.skip;

/**
 * Pins the shadow-DOM link-extraction contract (review finding,
 * link-extraction.ts:99): nav links inside open shadow roots (Lit/Stencil/
 * Material web components) must be discovered — a plain document query
 * silently dropped whole route subtrees.
 */
describeIfBrowser("extractLinksFromPage shadow DOM", () => {
    it("finds links rendered inside shadow roots", async () => {
        if (!chromium) return;
        const { extractLinksFromPage } = await import("../link-extraction");
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.setContent(`<!doctype html>
                <nav id="host"></nav>
                <a href="/light-link">Light</a>
                <script>
                    const host = document.getElementById("host");
                    const shadow = host.attachShadow({ mode: "open" });
                    shadow.innerHTML = '<a href="/shadow-link">Shadow</a>' +
                        '<div><a href="/nested-shadow">Nested</a></div>';
                </script>`);

            const links = await extractLinksFromPage(page);
            const hrefs = links.map((link) => link.href);
            expect(hrefs).toContain("/light-link");
            expect(hrefs).toContain("/shadow-link");
            expect(hrefs).toContain("/nested-shadow");
        } finally {
            await browser.close();
        }
    });
});
