import * as fs from "node:fs";
import * as path from "node:path";
import { parseAction, parseObservable, resolveFactUrl } from "./verify";
import type { RecordedMock } from "./record";
import { renderRouteMocks } from "./record";
import type { BehaviorFact } from "./types";

/**
 * The materializer: facts → disposable Playwright specs.
 *
 * Test code is an OUTPUT here, never the source of truth — materialized specs
 * are always current because they're compiled from the contract at request
 * time, and safe to delete because `materialize` regenerates them.
 */

export interface MaterializeOptions {
    baseURL: string;
    facts: BehaviorFact[];
    /** Path to a storage state for signed-in facts (baked into test.use). */
    storageStatePath?: string | null;
    /** Recorded GET responses to replay as page.route() mocks (hermetic runs). */
    mocks?: RecordedMock[];
    outDir: string;
    fileName?: string;
}

export interface MaterializeResult {
    specPath: string;
    testCount: number;
    skipped: number;
}

export function materializeFacts(options: MaterializeOptions): MaterializeResult {
    const { facts, baseURL, outDir } = options;
    const fileName = options.fileName ?? "contract.spec.ts";
    fs.mkdirSync(outDir, { recursive: true });

    const lines: string[] = [
        '// Materialized by `raiken contract materialize` — regenerated on demand,',
        "// NOT the source of truth. Edit the contract (facts), not this file.",
        "import { test, expect } from '@playwright/test';",
        "",
    ];
    if (options.storageStatePath) {
        lines.push(
            `test.use({ storageState: ${JSON.stringify(options.storageStatePath)} });`,
            "",
        );
    }

    if (options.mocks && options.mocks.length > 0) {
        lines.push(
            "// Recorded API responses (raiken contract record) — replays make",
            "// read-dependent facts pass even against a reset backend. Writes",
            "// are never mocked: the test must prove them live.",
            "test.beforeEach(async ({ page }) => {",
            renderRouteMocks(options.mocks),
            "});",
            "",
        );
    }

    let testCount = 0;
    let skipped = 0;

    for (const fact of facts) {
        const spec = parseObservable(fact.expectedObservable);
        const action = parseAction(fact.action);
        if (!spec) {
            skipped++;
            continue;
        }
        testCount++;

        const route = resolveFactUrl(fact.route, baseURL);
        // Several facts share a route+action (one per observable); the
        // observable suffix keeps Playwright titles unique per test.
        const suffix =
            spec.kind === "text" || spec.kind === "heading"
                ? ` — ${spec.text}`
                : "";
        const title = `${fact.route} — ${fact.action}${suffix}`.replace(/[^\w \-:.#/'"!?]/g, "");
        lines.push(`test('${title}', async ({ page }) => {`);
        lines.push(`  await page.goto('${route}');`);
        if (action.kind === "submit-empty") {
            lines.push(
                `  await page.getByRole('button', { name: '${action.label}' }).first().click();`,
            );
        }
        if (spec.kind === "heading") {
            lines.push(
                `  await expect(page.getByRole('heading', { name: ${JSON.stringify(spec.text)}, exact: true }).first()).toBeVisible();`,
            );
        } else if (spec.kind === "text") {
            lines.push(
                `  await expect(page.locator('body')).toContainText(${JSON.stringify(spec.text)});`,
            );
        } else {
            lines.push(
                `  // exposes inputs: ${(spec.labels ?? []).join(", ")}`,
                `  await expect(page.locator('input, select, textarea').first()).toBeVisible();`,
            );
        }
        lines.push("});", "");
    }

    const specPath = path.join(outDir, fileName);
    fs.writeFileSync(specPath, lines.join("\n"), "utf-8");
    return { specPath, testCount, skipped };
}
