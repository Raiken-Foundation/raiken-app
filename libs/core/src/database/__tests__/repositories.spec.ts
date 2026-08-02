/**
 * Repository contract tests — each internal repository is exercised through a
 * shared DbAdapter without going through the CodeGraphDB facade.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CodeNode, GraphEdge, ParsedSymbol } from "../../types";
import { closeDatabase, openDatabase } from "../connection";
import { AdminRepository } from "../repositories/admin.repository";
import { CodeGraphRepository } from "../repositories/code-graph.repository";
import { EmbeddingsRepository } from "../repositories/embeddings.repository";
import { MemoryRepository } from "../repositories/memory.repository";
import { SymbolsRepository } from "../repositories/symbols.repository";
import { TestOutcomesRepository } from "../repositories/test-outcomes.repository";

function makeNode(
    overrides: Partial<CodeNode> & Pick<CodeNode, "filePath" | "relativePath">,
): CodeNode {
    return {
        parsed: { functions: [], classes: [], imports: [], exports: [], types: [] },
        imports: [],
        importedBy: [],
        depth: 0,
        size: 10,
        lines: 1,
        lastModified: Date.now(),
        hash: "abc123",
        treeHash: "tree123",
        meta: {
            extension: ".ts",
            isTest: false,
            isEntry: false,
            hasExports: false,
            hasDefaultExport: false,
            complexity: 0,
        },
        ...overrides,
    };
}

describe("database repositories", () => {
    let testDir: string;
    let dbPath: string;
    let raw: Database.Database;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-repo-contract-"));
        dbPath = path.join(testDir, ".raiken", "raiken.db");
        const opened = openDatabase(testDir, dbPath);
        raw = opened.raw;
    });

    afterEach(() => {
        closeDatabase(raw);
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("AdminRepository lists tables and runs SELECT-only queries", () => {
        const opened = openDatabase(testDir, dbPath);
        const admin = new AdminRepository(opened.adapter);

        const tables = admin.getTables();
        expect(tables.some((t) => t.name === "files")).toBe(true);
        expect(admin.getTableCount("files")).toBe(0);

        const rows = admin.executeQuery("SELECT name FROM sqlite_master WHERE type = ?", ["table"]);
        expect(Array.isArray(rows)).toBe(true);
        expect(() => admin.executeQuery("DELETE FROM files")).toThrow(/Only SELECT/);
    });

    it("CodeGraphRepository persists and loads graph nodes", () => {
        const opened = openDatabase(testDir, dbPath);
        const symbols = new SymbolsRepository(opened.adapter);
        const graph = new CodeGraphRepository(opened.adapter, symbols);

        const filePath = path.join(testDir, "src/a.ts");
        const node = makeNode({ filePath, relativePath: "src/a.ts" });
        graph.saveGraph(new Map([[filePath, node]]), [], "scan");

        expect(graph.hasFile(filePath)).toBe(true);
        expect(graph.getStats()?.total_files).toBe(1);

        const loaded = graph.loadGraph();
        expect(loaded?.nodes.size).toBe(1);
        expect(loaded?.nodes.get(filePath)?.relativePath).toBe("src/a.ts");
    });

    it("EmbeddingsRepository stores vectors and keyword index", () => {
        const opened = openDatabase(testDir, dbPath);
        const symbols = new SymbolsRepository(opened.adapter);
        const embeddingsRepo = new EmbeddingsRepository(opened.adapter);
        const graph = new CodeGraphRepository(opened.adapter, symbols);

        const filePath = path.join(testDir, "src/embed.ts");
        graph.upsertFile(makeNode({ filePath, relativePath: "src/embed.ts" }));
        const fileId = embeddingsRepo.getFileId(filePath);
        expect(fileId).not.toBeNull();

        const vector = Array.from({ length: 384 }, (_, i) => (i % 10) / 10);
        if (fileId === null) throw new Error("expected file id");
        embeddingsRepo.saveEmbeddings(fileId, [
            { type: "function", name: "foo", text: "function foo() {}", embedding: vector },
        ]);
        expect(embeddingsRepo.hasEmbeddings(fileId)).toBe(true);
        expect(embeddingsRepo.getEmbeddingsCount()).toBe(1);

        const hits = embeddingsRepo.searchSimilar(vector, 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.chunkName).toBe("foo");

        embeddingsRepo.saveKeywordIndex(new Map([["login", [filePath]]]));
        const index = embeddingsRepo.loadKeywordIndex();
        expect(index?.get("login")).toEqual([filePath]);
    });

    it("MemoryRepository tracks preferences and selector history", () => {
        const opened = openDatabase(testDir, dbPath);
        const memory = new MemoryRepository(opened.adapter);

        memory.setPreference("theme", "dark");
        expect(memory.getPreference("theme")).toBe("dark");
        expect(memory.getAllPreferences()).toEqual({ theme: "dark" });

        memory.recordSelectorSuccess("submit button", '[data-testid="submit"]', "data-testid");
        memory.recordSelectorFailure("submit button", ".btn", "css");

        const best = memory.getBestSelector("submit button");
        expect(best?.selector).toBe('[data-testid="submit"]');
        expect(memory.getDominantSelectorType()?.type).toBe("data-testid");
    });

    it("TestOutcomesRepository records generation, results, and impact", () => {
        const opened = openDatabase(testDir, dbPath);
        const symbols = new SymbolsRepository(opened.adapter);
        const graph = new CodeGraphRepository(opened.adapter, symbols);
        const outcomes = new TestOutcomesRepository(opened.adapter);

        const src = path.join(testDir, "src/auth.ts");
        const testFile = "e2e/login.spec.ts";
        graph.upsertFile(makeNode({ filePath: src, relativePath: "src/auth.ts" }));
        graph.saveGraph(
            new Map([
                [
                    src,
                    makeNode({
                        filePath: src,
                        relativePath: "src/auth.ts",
                        imports: [path.join(testDir, "e2e/login.spec.ts")],
                    }),
                ],
                [
                    path.join(testDir, testFile),
                    makeNode({
                        filePath: path.join(testDir, testFile),
                        relativePath: testFile,
                        meta: {
                            extension: ".ts",
                            isTest: true,
                            isEntry: false,
                            hasExports: false,
                            hasDefaultExport: false,
                            complexity: 0,
                        },
                    }),
                ],
            ]),
            [],
            "scan",
        );

        const testId = outcomes.recordTestGenerated(testFile, "login", "prompt", "code");
        outcomes.recordTestResult(testId, "failed", 100, "timeout");
        outcomes.recordTestSourceFiles(testFile, [src]);

        expect(outcomes.getLatestTestOutcomeId(testFile)).toBe(testId);
        expect(outcomes.getRecentFailures(5)[0]?.testFile).toBe(testFile);
        expect(outcomes.getSourceFilesForTest(testFile)).toEqual([src]);

        const affected = outcomes.getAffectedTests([src]);
        expect(affected.some((a) => a.testFile === testFile && a.reason === "source_map")).toBe(
            true,
        );
    });

    it("TestOutcomesRepository upserts runner outcomes for specs the agent never generated", () => {
        const opened = openDatabase(testDir, dbPath);
        const outcomes = new TestOutcomesRepository(opened.adapter);
        const testFile = "tests/handwritten.spec.ts";

        // First run of a hand-written spec: no generation row exists, so an
        // insert with runner origin must be created.
        outcomes.upsertRunOutcome({
            testFile,
            testName: "checkout applies coupon",
            status: "failed",
            errorMessage: "locator resolved to 0 elements",
            failingSelector: "getByTestId('discount')",
        });

        const failures = outcomes.getRecentFailures(5);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.testFile).toBe(testFile);
        expect(failures[0]?.errorMessage).toBe("locator resolved to 0 elements");

        const origin = opened.adapter.db
            .prepare("SELECT origin, source_prompt FROM test_outcomes WHERE test_file = ?")
            .get(testFile) as { origin: string; source_prompt: string };
        expect(origin.origin).toBe("runner");
        expect(origin.source_prompt).toBe("");

        // A later passing run updates the same row instead of inserting a
        // duplicate, clearing it from the failure list.
        outcomes.upsertRunOutcome({
            testFile,
            testName: "checkout applies coupon",
            status: "passed",
            executionTimeMs: 900,
        });
        expect(outcomes.getRecentFailures(5)).toHaveLength(0);
        const count = opened.adapter.db
            .prepare("SELECT COUNT(*) AS n FROM test_outcomes WHERE test_file = ?")
            .get(testFile) as { n: number };
        expect(count.n).toBe(1);
    });

    it("upsertRunOutcome attaches to an existing agent-generated row for the same test", () => {
        const opened = openDatabase(testDir, dbPath);
        const outcomes = new TestOutcomesRepository(opened.adapter);
        const testFile = "tests/generated.spec.ts";

        const id = outcomes.recordTestGenerated(testFile, "login works", "prompt", "code");
        outcomes.upsertRunOutcome({ testFile, testName: "login works", status: "failed" });

        expect(outcomes.getLatestTestOutcomeId(testFile)).toBe(id);
        const row = opened.adapter.db
            .prepare("SELECT status, origin FROM test_outcomes WHERE id = ?")
            .get(id) as { status: string; origin: string };
        expect(row.status).toBe("failed");
        expect(row.origin).toBe("agent");
    });

    it("SymbolsRepository replaces symbols and edges per file", () => {
        const opened = openDatabase(testDir, dbPath);
        const symbols = new SymbolsRepository(opened.adapter);

        const filePath = path.join(testDir, "src/sym.ts");
        const sym: ParsedSymbol = {
            name: "handler",
            kind: "function",
            startLine: 1,
            endLine: 3,
            isExported: true,
            isAsync: false,
        };
        symbols.replaceFileSymbols(filePath, [sym]);
        expect(symbols.getFileSymbols(filePath)[0]?.name).toBe("handler");
        expect(symbols.findSymbolsByName("handler")[0]?.symbol.name).toBe("handler");

        const edge: GraphEdge = {
            kind: "imports",
            sourceFile: filePath,
            targetFile: path.join(testDir, "src/other.ts"),
            provenance: "static_ast",
            confidence: 1,
        };
        symbols.replaceFileEdges(filePath, [edge]);
        symbols.addEdges([
            {
                ...edge,
                kind: "calls",
                provenance: "test_run",
                targetSymbol: "otherFn",
            },
        ]);
        expect(
            symbols.getIncomingEdges([path.join(testDir, "src/other.ts")]).length,
        ).toBeGreaterThan(0);
        expect(symbols.getSymbolGraphStats().symbols).toBe(1);
    });
});
