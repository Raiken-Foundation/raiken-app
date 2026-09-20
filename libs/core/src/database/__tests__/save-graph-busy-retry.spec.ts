import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphDB } from "../../database/db";
import type { CodeNode } from "../../types";

/**
 * Pins the SQLITE_BUSY rethrow contract (review finding,
 * code-graph.repository.ts:207): a transient lock during saveGraph must
 * retry the whole transaction — never be recorded as a permanent per-file
 * skip that leaves a partially wiped graph behind.
 */

let project: string;

beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-busy-retry-"));
});

afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
});

function makeNode(filePath: string): CodeNode {
    return {
        filePath,
        relativePath: path.relative(project, filePath),
        parsed: { functions: [], classes: [], imports: [], exports: [], types: [] },
        imports: [],
        importedBy: [],
        depth: 0,
        size: 32,
        lines: 3,
        lastModified: 0,
        hash: "hash-1",
        treeHash: "tree-1",
        meta: {
            extension: ".ts",
            isTest: false,
            isEntry: false,
            hasExports: false,
            hasDefaultExport: false,
            complexity: 1,
        },
        symbols: [
            { name: "doWork", kind: "function", startLine: 1, endLine: 2, isExported: true },
        ],
    };
}

describe("saveGraph transient-lock handling", () => {
    it("retries the transaction on SQLITE_BUSY instead of skipping the file", () => {
        const db = new CodeGraphDB(project);
        try {
            const internals = db as unknown as {
                codeGraph: {
                    symbols: {
                        replaceFileSymbolsInTransaction: (
                            ...args: unknown[]
                        ) => unknown;
                    };
                };
            };
            const symbols = internals.codeGraph.symbols;
            const original = symbols.replaceFileSymbolsInTransaction.bind(symbols);
            let calls = 0;
            symbols.replaceFileSymbolsInTransaction = (
                ...args: unknown[]
            ) => {
                calls += 1;
                if (calls === 1) {
                    const error = new Error("database is locked");
                    (error as NodeJS.ErrnoException).code = "SQLITE_BUSY";
                    throw error;
                }
                return original(...args);
            };

            const node = makeNode(path.join(project, "src", "widget.ts"));
            const result = db.saveGraph(new Map([[node.filePath, node]]), []);

            // The transient failure was retried to success — no skip recorded.
            expect(result.skippedFiles).toHaveLength(0);
            expect(calls).toBe(2);
            expect(db.getStats()?.total_files ?? 0).toBeGreaterThanOrEqual(1);
        } finally {
            db.close();
        }
    });
});
