/**
 * Facade parity / golden test — end-to-end CodeGraphDB behavior after the
 * repository decomposition: lifecycle, migrations, graph CRUD, vectors,
 * memory, selectors, outcomes, symbols, close/reopen, busy timeout.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CodeNode, GraphEdge, ParsedSymbol } from "../../types";
import { CodeGraphDB } from "../db";

function sampleNode(projectRoot: string, rel: string, extra?: Partial<CodeNode>): CodeNode {
    const filePath = path.join(projectRoot, rel);
    return {
        filePath,
        relativePath: rel,
        parsed: {
            functions: [{ name: "fn", startLine: 1, endLine: 2, isExported: true, isAsync: false }],
            classes: [],
            imports: [],
            exports: ["fn"],
            types: [],
        },
        imports: [],
        importedBy: [],
        depth: 0,
        size: 42,
        lines: 3,
        lastModified: Date.now(),
        hash: CodeGraphDB.hashContent("export function fn() {}"),
        treeHash: "tree",
        meta: {
            extension: path.extname(rel),
            isTest: rel.includes(".spec."),
            isEntry: false,
            hasExports: true,
            hasDefaultExport: false,
            complexity: 1,
        },
        ...extra,
    };
}

describe("CodeGraphDB facade parity", () => {
    let testDir: string;
    let dbPath: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-db-parity-"));
        dbPath = path.join(testDir, ".raiken", "raiken.db");
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("creates a fresh database, migrates v5 auth_blockers, and reopens existing file", () => {
        // Seed a v5-shape database (mirrors site-discovery migration test).
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const legacy = new Database(dbPath);
        legacy.pragma("user_version = 5");
        legacy.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        last_indexed INTEGER NOT NULL,
        UNIQUE(project_path, file_path)
      );
      CREATE TABLE dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_path, source_file, target_file)
      );
      CREATE TABLE entry_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(project_path, file_path)
      );
      CREATE TABLE stats (
        project_path TEXT PRIMARY KEY,
        total_files INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        total_lines INTEGER NOT NULL,
        total_functions INTEGER NOT NULL,
        total_classes INTEGER NOT NULL,
        total_types INTEGER NOT NULL,
        last_scan INTEGER NOT NULL,
        schema_version INTEGER DEFAULT 1
      );
      CREATE TABLE discovery_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        start_url TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        pages_discovered INTEGER DEFAULT 0,
        links_found INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        blocked_at_url TEXT,
        queue_json TEXT,
        max_pages INTEGER,
        max_depth INTEGER
      );
      CREATE TABLE auth_blockers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        url TEXT NOT NULL,
        blocker_type TEXT NOT NULL,
        detected_elements TEXT,
        resolved_at INTEGER,
        storage_state_path TEXT,
        discovered_at INTEGER NOT NULL
      );
      INSERT INTO auth_blockers (id, project_path, url, blocker_type, detected_elements, resolved_at, storage_state_path, discovered_at)
      VALUES (1, '${testDir.replace(/'/g, "''")}', 'http://localhost/login', 'login_form', NULL, NULL, NULL, 1);
    `);
        legacy.close();

        const db1 = new CodeGraphDB(testDir, dbPath);
        const tables = db1.getTables().map((t) => t.name);
        expect(tables).toContain("discovery_blockers");
        expect(tables).not.toContain("auth_blockers");
        const blockers = db1
            .getRawDatabase()
            .prepare("SELECT id, category FROM discovery_blockers WHERE project_path = ?")
            .all(testDir) as Array<{ id: number; category: string }>;
        expect(blockers[0]?.id).toBe(1);
        expect(blockers[0]?.category).toBe("auth_required");
        expect(db1.getRawDatabase().pragma("user_version", { simple: true })).toBe(7);
        db1.close();

        const db2 = new CodeGraphDB(testDir, dbPath);
        expect(db2.getInfo().path).toBe(dbPath);
        expect(db2.getRawDatabase().open).toBe(true);
        db2.close();
        expect(() => db2.close()).not.toThrow();
    });

    it("runs graph CRUD, keyword search, memory, selectors, outcomes, and symbols", () => {
        const db = new CodeGraphDB(testDir, dbPath);
        const src = sampleNode(testDir, "src/app.ts");
        const testRel = "e2e/app.spec.ts";
        const testAbs = path.join(testDir, testRel);

        db.saveGraph(
            new Map([[src.filePath, src]]),
            [{ file: src.filePath, role: "app", type: "next" }],
            "scan",
        );
        expect(db.getStats()?.total_files).toBe(1);
        expect(db.getEntryPoints()[0]?.role).toBe("app");

        const sym: ParsedSymbol = {
            name: "fn",
            kind: "function",
            startLine: 1,
            endLine: 2,
            isExported: true,
            isAsync: false,
        };
        db.replaceFileSymbols(src.filePath, [sym]);
        expect(db.getFileSymbols(src.filePath)[0]?.name).toBe("fn");

        const edge: GraphEdge = {
            kind: "imports",
            sourceFile: src.filePath,
            targetFile: testAbs,
            provenance: "static_ast",
            confidence: 1,
        };
        db.replaceFileEdges(src.filePath, [edge]);
        expect(db.getSymbolGraphStats().edges).toBe(1);

        // Keyword index persistence (the search store after the vector cut).
        db.saveKeywordIndex(new Map([["app", [src.filePath]]]));
        expect(db.loadKeywordIndex()?.get("app")).toEqual([src.filePath]);

        db.setPreference("model", "gpt-test");
        expect(db.getPreference("model")).toBe("gpt-test");

        db.recordSelectorSuccess("button", '[data-testid="go"]', "data-testid");
        expect(db.getBestSelector("button")?.selector).toBe('[data-testid="go"]');

        const testId = db.recordTestGenerated(testRel, "app smoke", "prompt", "test(...)");
        db.recordTestResult(testId, "passed", 900);
        db.recordTestSourceFiles(testRel, [src.filePath]);
        expect(db.getLatestTestOutcomeId(testRel)).toBe(testId);
        expect(db.getAffectedTests([src.filePath]).some((r) => r.testFile === testRel)).toBe(true);

        db.removeFile(src.filePath);
        expect(db.hasFile(src.filePath)).toBe(false);

        db.vacuum();
        db.close();
    });

    it("configures WAL/busy_timeout and allows sequential multi-connection writes", () => {
        const db1 = new CodeGraphDB(testDir, dbPath);
        const db2 = new CodeGraphDB(testDir, dbPath);

        expect(db1.getRawDatabase().pragma("journal_mode", { simple: true })).toBe("wal");
        expect(db1.getRawDatabase().pragma("busy_timeout", { simple: true })).toBe(5000);

        const raw1 = db1.getRawDatabase();
        raw1.exec("BEGIN IMMEDIATE");
        raw1.prepare(
            "INSERT OR REPLACE INTO preferences (project_path, key, value, updated_at) VALUES (?, ?, ?, ?)",
        ).run(testDir, "held", "1", Date.now());
        raw1.exec("COMMIT");

        db2.setPreference("released", "2");
        expect(db2.getPreference("released")).toBe("2");

        db1.close();
        db2.close();
    });
});
