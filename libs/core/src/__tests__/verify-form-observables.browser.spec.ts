/**
 * Browser regression tests for form-observable verification — the round-3
 * dogfood defects: a form labeled the accessible way (`<label for>`,
 * `aria-labelledby`, wrapping `<label>`) minted facts that verify could not
 * re-observe (false violation on an unchanged app), and the submit label
 * minted into `exposes inputs […] and submit […]` was never checked.
 *
 * These run a real browser against file:// fixtures — the same class of test
 * as the dom-snapshot parity specs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { extractPageForms } from "../site-discovery/crawler/form-extractor";
import { verifyFacts, type FactVerdict } from "../contract/verify";
import type { BehaviorFact } from "../contract/types";

const LABELS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Chores</title></head>
<body>
    <!-- No aria-label, no placeholder/name overlap: the accessible pattern,
         and the exact markup that false-failed before the shared collector. -->
    <div role="heading" aria-level="1">Chores</div>
    <form id="add">
        <label for="title">New chore</label>
        <input id="title" name="chore_title" placeholder="What needs doing?">

        <span id="due-label">Due date</span>
        <input id="due" aria-labelledby="due-label">

        <label>
            Notes
            <textarea id="notes"></textarea>
        </label>

        <button type="submit">Add chore</button>
    </form>
</body>
</html>`;

const RENAMED_SUBMIT_HTML = LABELS_HTML.replace(
    "<button type=\"submit\">Add chore</button>",
    "<button type=\"submit\">Save chore</button>",
);

let fixtureDir: string;

function fact(route: string, expectedObservable: string, action = "open"): BehaviorFact {
    return {
        factKey: `${route}:${expectedObservable}`,
        route,
        precondition: null,
        action,
        expectedObservable,
        status: "verified",
        evidence: null,
        sourceCommit: null,
        capturedAt: Date.now(),
        lastVerifiedAt: null,
        verifiedCount: 1,
        violatedCount: 0,
        confidence: 1,
    };
}

async function verdicts(facts: BehaviorFact[]): Promise<Map<string, FactVerdict>> {
    const results = await verifyFacts({ facts, baseURL: `file://${fixtureDir}` });
    return new Map(results.map((v) => [v.expectedObservable, v]));
}

beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-verify-forms-"));
    fs.writeFileSync(path.join(fixtureDir, "labels.html"), LABELS_HTML, "utf-8");
    fs.writeFileSync(path.join(fixtureDir, "renamed.html"), RENAMED_SUBMIT_HTML, "utf-8");
});

afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("form observables re-observed through accessible names", () => {
    it("verifies a fact labeled only with <label for> (the round-3 false-fail)", async () => {
        const v = await verdicts([
            fact("labels.html", 'exposes inputs [New chore] and submit [Add chore]'),
        ]);
        const verdict = v.get('exposes inputs [New chore] and submit [Add chore]');
        expect(verdict?.verdict).toBe("verified");
    });

    it("verifies facts labeled with aria-labelledby and a wrapping <label>", async () => {
        const v = await verdicts([
            fact("labels.html", "exposes inputs [Due date]"),
            fact("labels.html", "exposes inputs [Notes]"),
        ]);
        expect(v.get("exposes inputs [Due date]")?.verdict).toBe("verified");
        expect(v.get("exposes inputs [Notes]")?.verdict).toBe("verified");
    });

    it("flags a renamed submit button instead of passing silently", async () => {
        const v = await verdicts([
            fact("renamed.html", 'exposes inputs [New chore] and submit [Add chore]'),
        ]);
        const verdict = v.get('exposes inputs [New chore] and submit [Add chore]');
        expect(verdict?.verdict).toBe("violated");
        expect(verdict?.detail).toContain("no longer present");
    });

    it("verifies heading observables on role=heading elements, not just h1-h4 tags", async () => {
        const v = await verdicts([fact("labels.html", 'shows heading "Chores"')]);
        expect(v.get('shows heading "Chores"')?.verdict).toBe("verified");
    });

    it("keeps discovery and verify on one collector: extractPageForms mints the same labels", async () => {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        try {
            await page.goto(`file://${path.join(fixtureDir, "labels.html")}`);
            const forms = JSON.parse((await extractPageForms(page)) ?? "{}") as {
                fields: Array<{ label: string }>;
                submits: string[];
            };
            expect(forms.fields.map((f) => f.label)).toEqual(
                expect.arrayContaining(["New chore", "Due date", "Notes"]),
            );
            expect(forms.submits).toContain("Add chore");
        } finally {
            await browser.close();
        }
    }, 30000);
}, 60000);
