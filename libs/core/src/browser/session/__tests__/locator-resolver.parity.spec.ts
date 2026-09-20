/**
 * Golden parity tests for LocatorResolver: selector resolution, fallback
 * ordering, strict-mode ambiguity handling, and selector-memory callbacks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../session";
import { LocatorResolver, resolveLocator } from "../locator-resolver";

const FIXTURE_HTML = `<!doctype html>
<html>
<body>
  <button id="primary" data-testid="go-btn">Go</button>
  <button id="hidden-btn" style="display:none">Hidden</button>
  <button id="visible-dup" class="dup">Dup A</button>
  <button class="dup">Dup B</button>
  <input id="email" name="email" aria-label="Email address" placeholder="you@example.com" />
  <iframe id="frame" srcdoc="
    <html><body>
      <button id='in-frame' onclick=&quot;document.title='Frame clicked'&quot;>Frame Button</button>
    </body></html>
  "></iframe>
</body>
</html>`;

describe("locator-resolver golden parity", () => {
    let fixtureDir: string;
    let fixturePath: string;
    let session: BrowserSession;
    let page: Page;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-locator-"));
        fixturePath = path.join(fixtureDir, "locator.html");
        fs.writeFileSync(fixturePath, FIXTURE_HTML, "utf-8");

        session = BrowserSession.getInstance(fixtureDir);
        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);
        page = (session as unknown as { page: Page }).page;
        await page.waitForTimeout(300);
    }, 30000);

    afterAll(async () => {
        await BrowserSession.reset();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("resolveLocator maps getBy* and legacy formats", async () => {
        expect(await resolveLocator("getByTestId('go-btn')", page).count()).toBe(1);
        expect(await resolveLocator("getByRole('button', { name: 'Go' })", page).count()).toBe(1);
        expect(await resolveLocator('role=button[name="Go"]', page).count()).toBe(1);
        expect(await resolveLocator("#primary", page).count()).toBe(1);
        expect(await resolveLocator("getByLabel('Email address')", page).count()).toBe(1);
        expect(await resolveLocator("getByPlaceholder('you@example.com')", page).count()).toBe(1);
    });

    it("tries selectors in order and records memory for first success", async () => {
        const memory = {
            successes: [] as string[],
            failures: [] as string[],
            recordSuccess: vi.fn((element: string, selector: string) => {
                memory.successes.push(`${element}:${selector}`);
            }),
            recordFailure: vi.fn((element: string, selector: string) => {
                memory.failures.push(`${element}:${selector}`);
            }),
        };

        session.setSelectorMemory(memory);
        const resolver = new LocatorResolver({
            getPage: () => page,
            getDefaultTimeout: () => 5000,
            selectorMemory: memory,
        });

        await resolver.runWithSelectors(
            "click",
            ["#missing", "getByTestId('go-btn')", "#primary"],
            (loc) => loc.click({ timeout: 3000 }),
        );

        expect(memory.recordFailure).toHaveBeenCalled();
        expect(memory.recordSuccess).toHaveBeenCalledWith(
            "#missing",
            "getByTestId('go-btn')",
            expect.any(String),
        );
        expect(memory.successes.some((s) => s.includes("getByTestId('go-btn')"))).toBe(true);

        session.setSelectorMemory(null);
    }, 15000);

    it("acts on first visible match when strict mode would fail", async () => {
        const resolver = new LocatorResolver({
            getPage: () => page,
            getDefaultTimeout: () => 5000,
            selectorMemory: null,
        });

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await resolver.runWithSelectors("click", ["button.dup"], (loc) =>
            loc.click({ timeout: 3000 }),
        );

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringMatching(/matched 2 elements.*first visible/i),
        );
        warnSpy.mockRestore();
    }, 15000);

    it("logs actions to stderr, not stdout (keeps --json stdout clean)", async () => {
        const resolver = new LocatorResolver({
            getPage: () => page,
            getDefaultTimeout: () => 5000,
            selectorMemory: null,
        });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await resolver.runWithSelectors("click", ["getByTestId('go-btn')"], (loc) =>
            loc.click({ timeout: 3000 }),
        );

        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("click: getByTestId('go-btn')"),
        );
        logSpy.mockRestore();
        errorSpy.mockRestore();
    }, 15000);

    it("finds elements inside child frames after main-frame miss", async () => {
        const resolver = new LocatorResolver({
            getPage: () => page,
            getDefaultTimeout: () => 5000,
            selectorMemory: null,
        });

        await resolver.runWithSelectors("click", ["#in-frame"], (loc) =>
            loc.click({ timeout: 5000 }),
        );

        const childFrame = page.frames().find((f) => f !== page.mainFrame());
        expect(childFrame).toBeDefined();
        if (!childFrame) throw new Error("expected child frame");
        expect(await childFrame.title()).toBe("Frame clicked");
    }, 15000);

    it("waitForSelector prefers already-present selector in a frame", async () => {
        const resolver = new LocatorResolver({
            getPage: () => page,
            getDefaultTimeout: () => 5000,
            selectorMemory: null,
        });

        await expect(
            resolver.waitForSelector(["#missing-first", "#primary"], 3000),
        ).resolves.toBeUndefined();
    }, 15000);
});
