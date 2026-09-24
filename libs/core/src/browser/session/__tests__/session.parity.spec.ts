/**
 * Golden parity tests for BrowserSession orchestration: selector-memory
 * callbacks after actions, invalid auth load preserving context, and
 * abort/close lifecycle via the registry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireBrowserSessionLease,
    releaseBrowserSessionLease,
    resetBrowserRegistry,
} from "../../registry";
import { BrowserSession } from "../../session";

const FIXTURE_HTML = `<!doctype html>
<html><body>
  <button id="action-btn" data-testid="action">Click me</button>
  <span id="result"></span>
  <script>
    document.getElementById('action-btn').addEventListener('click', () => {
      document.getElementById('result').textContent = 'clicked';
    });
  </script>
</body></html>`;

describe("BrowserSession orchestration golden parity", () => {
    let fixtureDir: string;
    let fixturePath: string;

    beforeEach(async () => {
        await resetBrowserRegistry();
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-session-parity-"));
        fixturePath = path.join(fixtureDir, "page.html");
        fs.writeFileSync(fixturePath, FIXTURE_HTML, "utf-8");
    });

    afterEach(async () => {
        await resetBrowserRegistry();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("fires selector-memory callbacks after successful actions", async () => {
        const session = BrowserSession.getInstance(fixtureDir);
        const memory = {
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };
        session.setSelectorMemory(memory);

        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);
        await session.click("getByTestId('action')");
        await session.settle();

        expect(memory.recordSuccess).toHaveBeenCalledWith(
            "getByTestId('action')",
            "getByTestId('action')",
            "data-testid",
        );
        expect(memory.recordFailure).not.toHaveBeenCalled();
    }, 30000);

    it("preserves browser handle when loadAuthState rejects invalid snapshot", async () => {
        const session = BrowserSession.getInstance(fixtureDir);
        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);

        const urlBefore = session.getCurrentUrl();
        const invalidPath = path.join(fixtureDir, "bad-auth.json");
        fs.writeFileSync(invalidPath, JSON.stringify({ cookies: [], origins: [] }));

        await expect(session.loadAuthState(invalidPath)).rejects.toThrow(/auth state/i);
        expect(session.isActive()).toBe(true);
        expect(session.getCurrentUrl()).toBe(urlBefore);
    }, 30000);

    it("closes browser on abort signal and force-release lifecycle", async () => {
        const project = path.join(fixtureDir, "abort-project");
        fs.mkdirSync(project, { recursive: true });

        const session = BrowserSession.getInstance(project);
        const closeSpy = vi.spyOn(session, "close");

        const controller = new AbortController();
        const lease = acquireBrowserSessionLease(project, controller.signal);
        await session.start({ headless: true });

        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await lease.release();

        expect(closeSpy).toHaveBeenCalled();

        closeSpy.mockClear();
        await releaseBrowserSessionLease(project, { forceClose: true });
        expect(closeSpy).toHaveBeenCalled();
    }, 30000);

    it("settle waits for post-action DOM without throwing", async () => {
        const session = BrowserSession.getInstance(fixtureDir);
        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);

        await session.click("#action-btn");
        const idle = await session.settle();
        expect(typeof idle).toBe("boolean");

        const page = (session as unknown as { page: import("playwright").Page }).page;
        expect(await page.locator("#result").textContent()).toBe("clicked");
    }, 30000);
});
