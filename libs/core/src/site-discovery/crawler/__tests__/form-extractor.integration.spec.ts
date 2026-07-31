import { afterEach, describe, expect, it } from "vitest";

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

describeIfBrowser("extractPageForms contract", () => {
    afterEach(async () => {
        // browsers closed per test
    });

    it("captures visible fields, submit buttons, and omits hidden inputs", async () => {
        if (!chromium) return;
        const { extractPageForms } = await import("../form-extractor");
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.setContent(`<!doctype html>
            <form>
                <input type="hidden" name="csrf" value="x" />
                <label>Email <input name="email" type="email" placeholder="you@example.com" required /></label>
                <label>Password <input name="password" type="password" /></label>
                <button type="submit">Sign in</button>
            </form>`);

        const raw = await extractPageForms(page);
        expect(raw).not.toBeNull();
        if (!raw) return;
        const parsed = JSON.parse(raw) as {
            fields: Array<{ label: string; type: string; name?: string; required?: boolean }>;
            submits: string[];
        };
        expect(parsed.fields).toHaveLength(2);
        expect(parsed.fields.some((f) => f.name === "email" && f.type === "email")).toBe(true);
        expect(parsed.fields.some((f) => f.name === "password")).toBe(true);
        expect(parsed.fields.find((f) => f.name === "email")?.required).toBe(true);
        expect(parsed.submits).toContain("Sign in");
        await browser.close();
    });

    it("returns null when no meaningful form controls exist", async () => {
        if (!chromium) return;
        const { extractPageForms } = await import("../form-extractor");
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.setContent("<html><body><p>No forms here</p></body></html>");
        expect(await extractPageForms(page)).toBeNull();
        await browser.close();
    });
});
