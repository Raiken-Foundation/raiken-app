/**
 * `raiken organize` coverage: deterministic config cleanup, test-file
 * inventory, AI-plan sanitization (untrusted LLM output must never move a
 * file it didn't validate against the real file list), and applying a plan
 * to disk + the code graph DB.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAIConfig } from "../agent/ai-providers";
import { CodeGraphDB } from "../database/db";

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock("../agent/ai-providers", async () => {
    const actual =
        await vi.importActual<typeof import("../agent/ai-providers")>("../agent/ai-providers");
    return {
        ...actual,
        createLangChainModel: () => ({ invoke: mocks.invoke }),
    };
});

describe("raiken organize", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-organize-"));
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        mocks.invoke.mockReset();
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function writeConfig(config: Record<string, unknown>) {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify(config, null, 2),
        );
    }

    function readConfig(): Record<string, unknown> {
        return JSON.parse(fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8"));
    }

    function writeSpec(relPath: string, contents = "import { test } from '@playwright/test';\n") {
        const abs = path.join(projectPath, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, contents, "utf-8");
    }

    // -------------------------------------------------------------------------
    // Config cleanup (deterministic)
    // -------------------------------------------------------------------------
    describe("analyzeConfigCleanup", () => {
        it("is a no-op (skipped) when there is no raiken.config.json", async () => {
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);
            expect(result.skipped).toBe(true);
            expect(result.changes).toHaveLength(0);
        });

        it("dedupes discovery.excludePatterns", async () => {
            writeConfig({
                testDirectory: "e2e",
                discovery: { excludePatterns: ["/logout", "/api/", "/logout"] },
            });
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);

            const change = result.changes.find((c) => c.path === "discovery.excludePatterns");
            expect(change).toBeDefined();
            expect(
                (result.cleanedConfig["discovery"] as Record<string, unknown>)["excludePatterns"],
            ).toEqual(["/logout", "/api/"]);
        });

        it("drops the dead outputFormats field", async () => {
            writeConfig({ testDirectory: "e2e", outputFormats: ["typescript"] });
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);

            expect(result.changes.some((c) => c.path === "outputFormats")).toBe(true);
            expect(result.cleanedConfig["outputFormats"]).toBeUndefined();
        });

        it("drops unrecognized top-level keys", async () => {
            writeConfig({ testDirectory: "e2e", someLegacyField: "leftover" });
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);

            expect(result.changes.some((c) => c.path === "someLegacyField")).toBe(true);
            expect(result.cleanedConfig["someLegacyField"]).toBeUndefined();
        });

        it("flags and syncs testDirectory drift against the Playwright config", async () => {
            writeConfig({ testDirectory: "e2e" });
            fs.writeFileSync(
                path.join(projectPath, "playwright.config.ts"),
                "export default { testDir: './tests' };\n",
            );
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);

            const change = result.changes.find((c) => c.path === "testDirectory");
            expect(change).toBeDefined();
            expect(change?.before).toBe("e2e");
            expect(change?.after).toBe("tests");
            expect(result.cleanedConfig["testDirectory"]).toBe("tests");
        });

        it("proposes no changes for an already-clean config", async () => {
            writeConfig({ testDirectory: "e2e", discovery: { excludePatterns: ["/api/"] } });
            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const result = await analyzeConfigCleanup(projectPath);
            expect(result.changes).toHaveLength(0);
            expect(result.skipped).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Test inventory
    // -------------------------------------------------------------------------
    describe("buildTestInventory", () => {
        it("extracts describe/test titles and excludes scratch run files", async () => {
            writeSpec(
                "e2e/login.spec.ts",
                `import { test } from '@playwright/test';
test.describe('Login', () => {
  test('shows an error on bad credentials', async () => {});
});
`,
            );
            writeSpec("e2e/foo.raiken-run-123456.spec.ts", "// scratch run — must be excluded");

            const { buildTestInventory } = await import("../organize/inventory");
            const inventory = buildTestInventory(projectPath, "e2e");

            expect(inventory).toHaveLength(1);
            expect(inventory[0]?.relativePath).toBe("e2e/login.spec.ts");
            expect(inventory[0]?.titles).toContain("Login");
            expect(inventory[0]?.titles).toContain("shows an error on bad credentials");
        });

        it("attaches known source files from test_source_map", async () => {
            writeSpec("e2e/checkout.spec.ts");
            const db = new CodeGraphDB(projectPath);
            db.recordTestSourceFiles(path.join("e2e", "checkout.spec.ts"), ["src/checkout.ts"]);
            db.close();

            const { buildTestInventory } = await import("../organize/inventory");
            const inventory = buildTestInventory(projectPath, "e2e");
            expect(inventory[0]?.sourceFiles).toEqual(["src/checkout.ts"]);
        });
    });

    // -------------------------------------------------------------------------
    // AI plan sanitization — untrusted model output must be validated
    // -------------------------------------------------------------------------
    describe("planTestOrganization", () => {
        const fakeAI: ResolvedAIConfig = {
            provider: "openrouter",
            apiKey: "test-key",
            apiKeySource: "config",
            model: "test-model",
            baseURL: "https://example.invalid",
            maxTokens: 4000,
            temperature: 0.7,
        };

        function inventoryOf(paths: string[]) {
            return paths.map((relativePath) => ({
                relativePath,
                titles: [],
                sourceFiles: [],
                sizeBytes: 10,
            }));
        }

        it("returns an empty plan without calling the model when there are 0-1 files", async () => {
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(inventoryOf(["e2e/a.spec.ts"]), "e2e", fakeAI);
            expect(plan.moves).toHaveLength(0);
            expect(mocks.invoke).not.toHaveBeenCalled();
        });

        it("accepts a well-formed plan", async () => {
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "Grouped by feature",
                    moves: [
                        {
                            from: "e2e/login.spec.ts",
                            to: "e2e/auth/login.spec.ts",
                            reason: "auth flow",
                        },
                    ],
                    warnings: [],
                }),
            });

            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );

            expect(plan.moves).toEqual([
                { from: "e2e/login.spec.ts", to: "e2e/auth/login.spec.ts", reason: "auth flow" },
            ]);
            expect(plan.usedModel).toBe("test-model");
        });

        it("drops a move referencing an unknown file into warnings", async () => {
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "x",
                    moves: [
                        { from: "e2e/ghost.spec.ts", to: "e2e/auth/ghost.spec.ts", reason: "x" },
                    ],
                    warnings: [],
                }),
            });
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );
            expect(plan.moves).toHaveLength(0);
            expect(plan.warnings.some((w) => /not a known test file/.test(w.message))).toBe(true);
        });

        it("drops a move whose destination escapes the test directory", async () => {
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "x",
                    moves: [{ from: "e2e/login.spec.ts", to: "../outside.spec.ts", reason: "x" }],
                    warnings: [],
                }),
            });
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );
            expect(plan.moves).toHaveLength(0);
            expect(plan.warnings.some((w) => /escapes/.test(w.message))).toBe(true);
        });

        it("drops a move that changes the file extension", async () => {
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "x",
                    moves: [{ from: "e2e/login.spec.ts", to: "e2e/login.spec.js", reason: "x" }],
                    warnings: [],
                }),
            });
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );
            expect(plan.moves).toHaveLength(0);
            expect(plan.warnings.some((w) => /extension/.test(w.message))).toBe(true);
        });

        it("drops a move whose destination collides with an existing file", async () => {
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "x",
                    moves: [
                        {
                            from: "e2e/login.spec.ts",
                            to: "e2e/checkout.spec.ts",
                            reason: "collide",
                        },
                    ],
                    warnings: [],
                }),
            });
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );
            expect(plan.moves).toHaveLength(0);
            expect(plan.warnings.some((w) => /collides/.test(w.message))).toBe(true);
        });

        it("produces a no-op plan (with a warning) when the model response isn't valid JSON", async () => {
            mocks.invoke.mockResolvedValue({ content: "not json at all" });
            const { planTestOrganization } = await import("../organize/plan");
            const plan = await planTestOrganization(
                inventoryOf(["e2e/login.spec.ts", "e2e/checkout.spec.ts"]),
                "e2e",
                fakeAI,
            );
            expect(plan.moves).toHaveLength(0);
            expect(plan.warnings.length).toBeGreaterThan(0);
        });
    });

    // -------------------------------------------------------------------------
    // Applying a plan to disk + the code graph DB
    // -------------------------------------------------------------------------
    describe("applyOrganizePlan", () => {
        it("moves files, updates test_source_map/test_outcomes, and writes the config", async () => {
            writeSpec("e2e/login.spec.ts");
            writeConfig({ testDirectory: "e2e", outputFormats: ["typescript"] });

            const db = new CodeGraphDB(projectPath);
            db.recordTestSourceFiles(path.join("e2e", "login.spec.ts"), ["src/login.ts"]);
            const outcomeId = db.recordTestGenerated(
                path.join("e2e", "login.spec.ts"),
                "login",
                "",
                "test(...)",
            );
            db.close();

            const { analyzeConfigCleanup } = await import("../organize/config-cleanup");
            const { applyOrganizePlan } = await import("../organize/apply");

            const result = {
                testDirectory: "e2e",
                testPlan: {
                    summary: "x",
                    moves: [
                        {
                            from: path.join("e2e", "login.spec.ts"),
                            to: path.join("e2e", "auth", "login.spec.ts"),
                            reason: "auth flow",
                        },
                    ],
                    warnings: [],
                },
                configCleanup: await analyzeConfigCleanup(projectPath),
            };

            const applyResult = await applyOrganizePlan(projectPath, result);

            expect(applyResult.errors).toHaveLength(0);
            expect(applyResult.movedFiles).toBe(1);
            expect(applyResult.configWritten).toBe(true);
            expect(fs.existsSync(path.join(projectPath, "e2e", "auth", "login.spec.ts"))).toBe(
                true,
            );
            expect(fs.existsSync(path.join(projectPath, "e2e", "login.spec.ts"))).toBe(false);
            expect(readConfig()["outputFormats"]).toBeUndefined();

            const db2 = new CodeGraphDB(projectPath);
            expect(db2.getSourceFilesForTest(path.join("e2e", "auth", "login.spec.ts"))).toEqual([
                "src/login.ts",
            ]);
            expect(db2.getSourceFilesForTest(path.join("e2e", "login.spec.ts"))).toEqual([]);
            const outcome = db2.getTestOutcome(outcomeId);
            expect(outcome?.testFile).toBe(path.join("e2e", "auth", "login.spec.ts"));
            db2.close();
        });

        it("handles a rename chain (A's destination is B's current path) without collisions", async () => {
            writeSpec("e2e/a.spec.ts", "// A\n");
            writeSpec("e2e/b.spec.ts", "// B\n");

            const { applyOrganizePlan } = await import("../organize/apply");
            const result = {
                testDirectory: "e2e",
                testPlan: {
                    summary: "x",
                    moves: [
                        {
                            from: path.join("e2e", "a.spec.ts"),
                            to: path.join("e2e", "b.spec.ts"),
                            reason: "x",
                        },
                        {
                            from: path.join("e2e", "b.spec.ts"),
                            to: path.join("e2e", "c.spec.ts"),
                            reason: "x",
                        },
                    ],
                    warnings: [],
                },
            };

            const applyResult = await applyOrganizePlan(projectPath, result);

            expect(applyResult.errors).toHaveLength(0);
            expect(applyResult.movedFiles).toBe(2);
            expect(fs.readFileSync(path.join(projectPath, "e2e", "b.spec.ts"), "utf-8")).toBe(
                "// A\n",
            );
            expect(fs.readFileSync(path.join(projectPath, "e2e", "c.spec.ts"), "utf-8")).toBe(
                "// B\n",
            );
            expect(fs.existsSync(path.join(projectPath, "e2e", "a.spec.ts"))).toBe(false);
        });

        it("rewrites path-form quarantine entries for moved specs", async () => {
            writeSpec("e2e/login.spec.ts", "// quarantined flaky spec\n");
            fs.writeFileSync(
                path.join(projectPath, "raiken.config.json"),
                JSON.stringify({
                    testDirectory: "e2e",
                    quarantine: { testFiles: ["e2e/login.spec.ts", "e2e/other.spec.ts"] },
                }),
            );

            const { applyOrganizePlan } = await import("../organize/apply");
            const applyResult = await applyOrganizePlan(projectPath, {
                testDirectory: "e2e",
                testPlan: {
                    summary: "x",
                    moves: [
                        {
                            from: path.join("e2e", "login.spec.ts"),
                            to: path.join("e2e", "auth", "login.spec.ts"),
                            reason: "x",
                        },
                    ],
                    warnings: [],
                },
            });

            expect(applyResult.errors).toHaveLength(0);
            expect(applyResult.movedFiles).toBe(1);
            const config = JSON.parse(
                fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8"),
            ) as { quarantine: { testFiles: string[] } };
            // The moved spec STAYS quarantined under its new path (review
            // finding: it used to silently escape and rejoin normal runs).
            expect(config.quarantine.testFiles).toContain(
                path.join("e2e", "auth", "login.spec.ts"),
            );
            expect(config.quarantine.testFiles).not.toContain("e2e/login.spec.ts");
            // Untouched entries are preserved verbatim.
            expect(config.quarantine.testFiles).toContain("e2e/other.spec.ts");
        });

        it("rewrites relative imports inside moved files and in files that reference them", async () => {
            writeSpec(
                "e2e/login.spec.ts",
                'import { test } from "./fixtures";\nimport { LoginPage } from "./pages/login-page";\n',
            );
            writeSpec("e2e/fixtures.ts", "export const test = 1;\n");
            writeSpec("e2e/pages/login-page.ts", "export class LoginPage {}\n");
            writeSpec("e2e/smoke.spec.ts", 'import "./login.spec";\n');

            const { applyOrganizePlan } = await import("../organize/apply");
            const applyResult = await applyOrganizePlan(projectPath, {
                testDirectory: "e2e",
                testPlan: {
                    summary: "x",
                    moves: [
                        {
                            from: "e2e/login.spec.ts",
                            to: "e2e/auth/login.spec.ts",
                            reason: "auth flow",
                        },
                    ],
                    warnings: [],
                },
            });

            expect(applyResult.errors).toHaveLength(0);
            expect(applyResult.movedFiles).toBe(1);
            expect(applyResult.rewrittenImportFiles).toBe(2);

            const moved = fs.readFileSync(
                path.join(projectPath, "e2e", "auth", "login.spec.ts"),
                "utf-8",
            );
            expect(moved).toContain('from "../fixtures"');
            expect(moved).toContain('from "../pages/login-page"');

            const referrer = fs.readFileSync(
                path.join(projectPath, "e2e", "smoke.spec.ts"),
                "utf-8",
            );
            expect(referrer).toContain('import "./auth/login.spec"');
        });

        it("never overwrites an existing destination file", async () => {
            writeSpec("e2e/a.spec.ts", "// A\n");
            writeSpec("e2e/b.spec.ts", "// B\n");

            const { applyOrganizePlan } = await import("../organize/apply");
            const applyResult = await applyOrganizePlan(projectPath, {
                testDirectory: "e2e",
                testPlan: {
                    summary: "x",
                    moves: [
                        // b.spec.ts is NOT part of any move, so a's destination
                        // is occupied — the apply must refuse and restore a.
                        { from: "e2e/a.spec.ts", to: "e2e/b.spec.ts", reason: "x" },
                    ],
                    warnings: [],
                },
            });

            expect(applyResult.movedFiles).toBe(0);
            expect(applyResult.errors).toHaveLength(1);
            expect(applyResult.errors[0]).toContain("destination already exists");
            expect(fs.readFileSync(path.join(projectPath, "e2e", "a.spec.ts"), "utf-8")).toBe(
                "// A\n",
            );
            expect(fs.readFileSync(path.join(projectPath, "e2e", "b.spec.ts"), "utf-8")).toBe(
                "// B\n",
            );
        });

        it("rejects moves of non-spec files (helpers/fixtures stay put)", async () => {
            const { planTestOrganization } = await import("../organize/plan");
            mocks.invoke.mockResolvedValue({
                content: JSON.stringify({
                    summary: "x",
                    moves: [
                        { from: "e2e/fixtures.ts", to: "e2e/shared/fixtures.ts", reason: "x" },
                        { from: "e2e/a.spec.ts", to: "e2e/auth/a.spec.ts", reason: "x" },
                    ],
                    warnings: [],
                }),
            });

            const plan = await planTestOrganization(
                [
                    { relativePath: "e2e/fixtures.ts", titles: [], sourceFiles: [], sizeBytes: 1 },
                    { relativePath: "e2e/a.spec.ts", titles: [], sourceFiles: [], sizeBytes: 1 },
                ],
                "e2e",
                { provider: "anthropic", model: "m", apiKey: "k" } as ResolvedAIConfig,
            );

            expect(plan.moves).toEqual([
                { from: "e2e/a.spec.ts", to: "e2e/auth/a.spec.ts", reason: "x" },
            ]);
            expect(plan.warnings.some((w) => w.message.includes("not a spec file"))).toBe(true);
        });
    });
});
