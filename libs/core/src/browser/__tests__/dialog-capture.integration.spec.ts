/**
 * Modal landmarks must survive DOM capture. Without them, the captured page
 * lists only the controls inside a modal, so nothing distinguishes `dialog`
 * from `alertdialog` — a generated test picks the wrong one, fails at runtime,
 * and grounding has no evidence to catch it.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateSelectorGrounding } from "../../agent/grounding";
import { formatDOMContext } from "../dom-capture";
import { BrowserSession } from "../session";

function loadChromium() {
    try {
        return require("playwright").chromium as typeof import("playwright").chromium | null;
    } catch {
        return null;
    }
}

const PAGE_HTML = `<!doctype html>
<html>
    <head><title>Projects</title></head>
    <body>
        <main>
            <h1>Projects</h1>
            <button type="button">Delete</button>
        </main>
        <div class="modal-overlay">
            <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="delete-project">
                <h2 id="confirm-title">Delete project</h2>
                <p>This permanently removes the project and every task inside it.</p>
                <button type="button" data-testid="delete-project-cancel">Cancel</button>
                <button type="button" data-testid="delete-project-confirm">Delete forever</button>
            </div>
        </div>
    </body>
</html>`;

const chromium = loadChromium();
const describeIfBrowser = chromium ? describe : describe.skip;

describeIfBrowser("modal landmark capture integration", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(PAGE_HTML);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("captures the alertdialog landmark with its authored accessible name", async () => {
        const session = BrowserSession.__create("/tmp/raiken-dialog-capture", { headless: true });
        try {
            await session.start({ headless: true });
        } catch {
            return; // No browser binary available in this environment.
        }

        try {
            const dom = await session.navigate(`${baseUrl}/projects`);
            const modal = dom.interactiveElements.find((el) => el.role === "alertdialog");

            expect(modal).toBeDefined();
            expect(modal?.name).toBe("Delete project");
            expect(modal?.suggestedSelectors).toContain(
                "getByRole('alertdialog', { name: 'Delete project' })",
            );
            // The modal's descriptive copy must not leak into its name or into a
            // text locator, or every selector built from it would be unusable.
            expect(modal?.name).not.toContain("permanently removes");
            expect(modal?.suggestedSelectors.join(" ")).not.toContain("getByText");

            const summary = formatDOMContext(dom);
            expect(
                validateSelectorGrounding(
                    "await expect(page.getByRole('alertdialog', { name: 'Delete project' })).toBeVisible();",
                    [summary],
                ).ok,
            ).toBe(true);

            const mismatch = validateSelectorGrounding(
                "await expect(page.getByRole('dialog', { name: 'Delete project' })).toBeVisible();",
                [summary],
            );
            expect(mismatch.contradictions.map((v) => v.kind)).toEqual(["role_mismatch"]);
        } finally {
            await session.close();
        }
    });
});
