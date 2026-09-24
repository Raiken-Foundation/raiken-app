/**
 * Golden parity tests for DomSnapshotBuilder output shape and content.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../session";
import { DomSnapshotBuilder } from "../dom-snapshot-builder";

const FIXTURE_HTML = `<!doctype html>
<html>
<head><title>Snapshot Golden</title></head>
<body>
  <h1>Welcome</h1>
  <button id="submit" data-testid="submit-btn" type="submit">Submit</button>
  <a href="https://example.com/about" data-testid="about-link">About</a>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" placeholder="you@example.com" required />
  <dialog open aria-label="Confirm action">
    <button id="confirm">OK</button>
  </dialog>
</body>
</html>`;

describe("dom-snapshot-builder golden parity", () => {
    let fixtureDir: string;
    let fixturePath: string;
    let session: BrowserSession;
    let builder: DomSnapshotBuilder;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-snapshot-"));
        fixturePath = path.join(fixtureDir, "snapshot.html");
        fs.writeFileSync(fixturePath, FIXTURE_HTML, "utf-8");

        session = BrowserSession.getInstance(fixtureDir);
        await session.start({ headless: true });
        await session.navigate(`file://${fixturePath}`);

        const page = (session as unknown as { page: Page }).page;
        builder = new DomSnapshotBuilder({
            getPage: () => page,
            getPerformanceSignals: () => ({
                lastNavigationMs: 42,
                lastNetworkIdle: true,
            }),
        });
    }, 30000);

    afterAll(async () => {
        await BrowserSession.reset();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("captures stable DOM context shape with grounded selectors", async () => {
        const dom = await builder.capture();

        expect(dom.url).toContain("snapshot.html");
        expect(dom.title).toBe("Snapshot Golden");
        expect(dom.timestamp).toBeGreaterThan(0);
        expect(dom.accessibilityTree?.role).toBe("WebArea");
        expect(dom.accessibilityTree?.name).toBe("Snapshot Golden");

        const submit = dom.interactiveElements.find((el) => el.testId === "submit-btn");
        expect(submit).toBeDefined();
        expect(submit?.suggestedSelectors[0]).toBe("getByTestId('submit-btn')");
        expect(submit?.suggestedSelectors).toContain("getByRole('button', { name: 'Submit' })");

        const emailField = dom.formFields.find((f) => f.id === "email");
        expect(emailField).toBeDefined();
        expect(emailField?.suggestedSelector).toBe("#email");

        const dialog = dom.interactiveElements.find((el) => el.role === "dialog");
        expect(dialog?.name).toBe("Confirm action");
        expect(
            dialog?.suggestedSelectors.some(
                (s) => s.includes("dialog") || s.includes("Confirm action"),
            ),
        ).toBe(true);

        expect(dom.performance?.navigationMs).toBe(42);
        expect(dom.performance?.networkIdle).toBe(true);
    });

    it("discoverLinks returns deduped hrefs with suggested selectors", async () => {
        const links = await builder.discoverLinks();
        const about = links.find((l) => l.text === "About");
        expect(about).toBeDefined();
        expect(about?.href).toContain("example.com/about");
        expect(about?.suggestedSelectors[0]).toBe("getByTestId('about-link')");
        expect(about?.isExternal).toBe(true);
    });
});
