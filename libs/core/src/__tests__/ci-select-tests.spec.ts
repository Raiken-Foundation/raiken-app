import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraftIndex } from "../analysis/graft";
import type { AffectedTestEvidence } from "../analysis/graph-query";
import { type SelectTestsSources, selectAffectedTests, visitedPaths } from "../ci/select-tests";
import type { CiChangedFile } from "../ci/types";
import { dependentsFromIndex, extractRouteBindings } from "../contract/impact";

/**
 * `raiken ci` must never answer "no tests affected" for a change it cannot
 * trace: before this, a Playwright suite (specs import no app code) or a
 * missing/stale graph selected nothing and CI went green having run nothing.
 */

const FILES: Record<string, string> = {
    "src/main.tsx": `
import { createBrowserRouter } from "react-router-dom";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";
export const router = createBrowserRouter([
    { path: "/settings", element: <Settings /> },
    { path: "/tasks", element: <Tasks /> },
]);`,
    "src/pages/Settings.tsx":
        'import ConfirmDialog from "../components/ConfirmDialog";\nexport default function Settings() { return <ConfirmDialog />; }',
    "src/pages/Tasks.tsx": "export default function Tasks() { return null; }",
    "src/components/ConfirmDialog.tsx": "export default function ConfirmDialog() { return null; }",
    "src/api/billing.ts": "export function charge() {}",
    "e2e/settings.spec.ts": "test('s', async ({ page }) => { await page.goto('/settings'); });",
    "e2e/tasks.spec.ts":
        "test('t', async ({ page }) => { await page.goto(\"http://localhost:5100/tasks?tab=all\"); });",
    "e2e/helper-driven.spec.ts": "test('h', async ({ page }) => { await openApp(page); });",
};

const IMPORTS: Record<string, string[]> = {
    "src/main.tsx": ["src/pages/Settings.tsx", "src/pages/Tasks.tsx"],
    "src/pages/Settings.tsx": ["src/components/ConfirmDialog.tsx"],
};

const SPECS = ["e2e/helper-driven.spec.ts", "e2e/settings.spec.ts", "e2e/tasks.spec.ts"];

function changed(...paths: string[]): CiChangedFile[] {
    return paths.map((p) => ({ path: p, status: "modified" as const }));
}

describe("selectAffectedTests", () => {
    let dir: string;
    let sources: SelectTestsSources;
    let recorded: AffectedTestEvidence[];
    let graphAvailable: boolean;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ci-select-")));
        for (const [rel, content] of Object.entries(FILES)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        const index = new GraftIndex(dir, {
            nodes: Object.keys(FILES).map((rel) => ({
                id: rel,
                name: path.basename(rel),
                kind: "file",
                path: rel,
                span: "L1-L1",
                signature: null,
                exported: true,
            })),
            edges: Object.entries(IMPORTS).flatMap(([source, targets]) =>
                targets.map((target) => ({
                    source,
                    target,
                    relation: "imports",
                    confidence: "extracted",
                })),
            ),
        });
        recorded = [];
        graphAvailable = true;
        sources = {
            loadGraph: async () =>
                graphAvailable
                    ? { graph: dependentsFromIndex(index) }
                    : {
                          graph: null,
                          reason: "the tree-sitter-kotlin parser has no prebuilt binary",
                      },
            recordedEvidence: () => recorded,
            listSpecFiles: () => SPECS,
            routeBindings: extractRouteBindings,
        };
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const select = (
        files: CiChangedFile[],
        extra: { fallback?: "full" | "none"; threshold?: number } = {},
    ) =>
        selectAffectedTests(
            {
                projectPath: dir,
                changedFiles: files,
                confidenceThreshold: extra.threshold ?? 0.5,
                fallback: extra.fallback,
            },
            sources,
        );

    it("selects the E2E spec that visits a route the change reaches, with the path as evidence", async () => {
        const result = await select(changed("src/components/ConfirmDialog.tsx"));
        expect(result.selection.mode).toBe("impact");
        expect(result.affectedTests.map((t) => t.testFile)).toEqual(["e2e/settings.spec.ts"]);
        expect(result.affectedTests[0].reasons[0]).toMatchObject({
            reason: "route",
            snippet:
                "goto('/settings') → /settings ← src/pages/Settings.tsx ← src/components/ConfirmDialog.tsx",
        });
    });

    it("matches absolute goto URLs by pathname", async () => {
        const result = await select(changed("src/pages/Tasks.tsx"));
        expect(result.affectedTests.map((t) => t.testFile)).toEqual(["e2e/tasks.spec.ts"]);
    });

    it("runs the full suite when a changed file reaches no test, naming the file", async () => {
        const result = await select(
            changed("src/components/ConfirmDialog.tsx", "src/api/billing.ts"),
        );
        expect(result.selection).toMatchObject({ mode: "full", unmapped: ["src/api/billing.ts"] });
        expect(result.affectedTests.map((t) => t.testFile)).toEqual(SPECS);
        expect(result.affectedTests[0].reasons[0].reason).toBe("fallback");
    });

    it("runs the full suite when the code graph is unavailable", async () => {
        graphAvailable = false;
        const result = await select(changed("src/pages/Tasks.tsx"));
        expect(result.selection.mode).toBe("full");
        expect(result.selection.graph).toEqual({
            available: false,
            reason: "the tree-sitter-kotlin parser has no prebuilt binary",
        });
        expect(result.affectedTests).toHaveLength(SPECS.length);
    });

    it("runs the full suite for global files (config, styles)", async () => {
        expect((await select(changed("playwright.config.ts"))).selection.mode).toBe("full");
        expect((await select(changed("src/styles.css"))).selection.mode).toBe("full");
    });

    it("treats evidence below the threshold as unproven", async () => {
        const result = await select(changed("src/components/ConfirmDialog.tsx"), {
            threshold: 0.9,
        });
        expect(result.selection.mode).toBe("full");
        expect(result.selection.unmapped).toEqual(["src/components/ConfirmDialog.tsx"]);
    });

    it("runs nothing only when no source file changed", async () => {
        const docs = await select(changed("README.md", "docs/guide.md"));
        expect(docs.selection.mode).toBe("none");
        expect(docs.affectedTests).toEqual([]);

        const specOnly = await select(changed("e2e/tasks.spec.ts"));
        expect(specOnly.selection.mode).toBe("impact");
        expect(specOnly.affectedTests.map((t) => t.testFile)).toEqual(["e2e/tasks.spec.ts"]);
    });

    it("--fallback none keeps the old behavior but says so", async () => {
        const result = await select(changed("src/api/billing.ts", "e2e/tasks.spec.ts"), {
            fallback: "none",
        });
        expect(result.affectedTests.map((t) => t.testFile)).toEqual(["e2e/tasks.spec.ts"]);
        expect(result.selection.reason).toMatch(/fallback disabled/);
        expect(result.selection.unmapped).toEqual(["src/api/billing.ts"]);
    });

    it("normalizes recorded evidence keyed by absolute path to project-relative files", async () => {
        recorded = [
            {
                testFile: path.join(dir, "e2e/helper-driven.spec.ts"),
                sourceFile: path.join(dir, "src/api/billing.ts"),
                confidence: 1,
                reasons: [{ reason: "source_map", provenance: "manual", confidence: 1 }],
            },
        ];
        const result = await select(changed("src/api/billing.ts"));
        expect(result.selection.mode).toBe("impact");
        expect(result.affectedTests).toEqual([
            expect.objectContaining({
                testFile: "e2e/helper-driven.spec.ts",
                sourceFiles: ["src/api/billing.ts"],
            }),
        ]);
    });
});

describe("visitedPaths", () => {
    it("reads literal goto targets and skips dynamic ones", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-visits-"));
        try {
            const spec = path.join(dir, "a.spec.ts");
            fs.writeFileSync(
                spec,
                [
                    "await page.goto('/cart');",
                    'await page.goto("https://shop.test/checkout/");',
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: spec source text, a dynamic goto target
                    "await page.goto(`/orders/${id}`);",
                    "await page.goto(url);",
                ].join("\n"),
            );
            expect(visitedPaths(spec).sort()).toEqual(["/cart", "/checkout"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("selectAffectedTests with the real code graph (graft)", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ci-graft-")));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("finds tests through imports and routes without a prior `raiken index`", async () => {
        for (const [rel, content] of Object.entries({
            ...FILES,
            "src/lib/price.ts": "export function price(c: number) { return c / 100; }\n",
            "tests/price.spec.ts":
                'import { price } from "../src/lib/price";\nexport const ok = price(100) === 1;\n',
        })) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        fs.writeFileSync(
            path.join(dir, "raiken.config.json"),
            JSON.stringify({ testDirectory: "." }),
        );

        const unit = await selectAffectedTests({
            projectPath: dir,
            changedFiles: changed("src/lib/price.ts"),
            confidenceThreshold: 0.5,
        });
        expect(unit.selection).toMatchObject({ mode: "impact" });
        expect(unit.affectedTests.map((t) => t.testFile)).toEqual(["tests/price.spec.ts"]);
        expect(unit.affectedTests[0].reasons[0]).toMatchObject({
            reason: "imports",
            confidence: 0.85,
        });

        const e2e = await selectAffectedTests({
            projectPath: dir,
            changedFiles: changed("src/components/ConfirmDialog.tsx"),
            confidenceThreshold: 0.5,
        });
        expect(e2e.selection).toMatchObject({ mode: "impact" });
        expect(e2e.affectedTests.map((t) => t.testFile)).toEqual(["e2e/settings.spec.ts"]);
    }, 60_000);
});
