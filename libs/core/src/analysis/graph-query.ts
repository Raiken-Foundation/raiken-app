import * as path from "node:path";
import { CodeGraphDB } from "../database/db";
import type { GraphEdge, ParsedSymbol } from "../types";

/**
 * Reason a test was flagged as affected by a source change.
 * Ordered roughly from highest- to lowest- evidence.
 */
export type AffectReason =
    | "changed_test" // the test file itself changed in the diff
    | "source_map" // explicit user-recorded mapping
    | "runtime" // captured during a real test run
    | "imports" // static dependency: test file imports the changed file
    | "calls" // symbol-level call from a test symbol into changed code
    | "renders" // JSX render of an exported component
    | "name_match"; // weakest: name overlap between test file and source

export interface AffectedTestEvidence {
    testFile: string;
    sourceFile: string;
    reasons: Array<{
        reason: AffectReason;
        provenance: GraphEdge["provenance"] | "manual";
        confidence: number;
        line?: number;
        snippet?: string;
        sourceSymbol?: string;
        targetSymbol?: string;
    }>;
    /** Aggregated confidence (highest reason). */
    confidence: number;
}

export interface AffectedSymbolEvidence {
    file: string;
    symbol: ParsedSymbol;
    /** What changed source file caused us to flag this symbol. */
    triggeredBy: string;
    reasons: Array<{
        reason: "imports" | "calls" | "renders" | "extends" | "implements";
        confidence: number;
        line?: number;
        snippet?: string;
    }>;
    confidence: number;
}

/**
 * Explainable query layer over the symbol graph.
 *
 * Every call returns evidence: which edges/files contributed, with what
 * confidence, and citing the underlying provenance (static_ast, runtime,
 * manual mapping). Callers (the dashboard, the ticket analyzer, the test
 * generator) can show the user "why" a test was flagged, not just "that"
 * it was.
 */
export class GraphQueryService {
    private projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = path.resolve(projectPath);
    }

    /**
     * Tests likely affected by the given changed source files.
     *
     * Combines four signals with descending priority:
     *   1. test_source_map (explicit, user-recorded)
     *   2. runtime / test_run edges (proven at execution)
     *   3. import edges from test files into the changed code
     *   4. symbol-level calls/renders from tests into the changed code
     */
    getAffectedTests(changedSourceFiles: string[]): AffectedTestEvidence[] {
        if (changedSourceFiles.length === 0) return [];

        const db = new CodeGraphDB(this.projectPath);
        try {
            const merged = new Map<string, AffectedTestEvidence>();
            const upsert = (
                testFile: string,
                sourceFile: string,
                reason: AffectedTestEvidence["reasons"][number],
            ) => {
                const key = `${testFile}::${sourceFile}`;
                const existing = merged.get(key);
                if (existing) {
                    existing.reasons.push(reason);
                    existing.confidence = Math.max(existing.confidence, reason.confidence);
                    return;
                }
                merged.set(key, {
                    testFile,
                    sourceFile,
                    reasons: [reason],
                    confidence: reason.confidence,
                });
            };

            // ---- Signal 1 + 3: explicit source_map and import-based dependents
            const legacy = db.getAffectedTests(changedSourceFiles);
            for (const row of legacy) {
                if (row.reason === "source_map") {
                    upsert(row.testFile, row.sourceFile, {
                        reason: "source_map",
                        provenance: "manual",
                        confidence: 1.0,
                    });
                } else {
                    upsert(row.testFile, row.sourceFile, {
                        reason: "imports",
                        provenance: "static_ast",
                        confidence: 0.85,
                    });
                }
            }

            // ---- Signal 2 + 4: edge-based (calls / renders / runtime) from any
            // test file into a changed source file.
            const incoming = db.getIncomingEdges(changedSourceFiles, {
                kinds: ["calls", "renders", "imports"],
            });

            for (const edge of incoming) {
                if (!isLikelyTestPath(edge.sourceFile)) continue;

                if (edge.kind === "imports") continue; // already covered by Signal 3

                upsert(edge.sourceFile, edge.targetFile, {
                    reason: edge.kind === "calls" ? "calls" : "renders",
                    provenance: edge.provenance,
                    confidence: edge.confidence,
                    line: edge.evidence?.line,
                    snippet: edge.evidence?.snippet,
                    sourceSymbol: edge.sourceSymbol,
                    targetSymbol: edge.targetSymbol,
                });
            }

            // Sort: highest confidence first, then test file name for stable output.
            return Array.from(merged.values()).sort((a, b) => {
                if (b.confidence !== a.confidence) return b.confidence - a.confidence;
                return a.testFile.localeCompare(b.testFile);
            });
        } finally {
            db.close();
        }
    }

    /**
     * Symbols likely affected by changes to the given source files.
     * Useful when you want to know "which functions need re-testing" rather
     * than "which whole files are affected".
     */
    getAffectedSymbols(changedSourceFiles: string[]): AffectedSymbolEvidence[] {
        if (changedSourceFiles.length === 0) return [];
        const db = new CodeGraphDB(this.projectPath);
        try {
            const incoming = db.getIncomingEdges(changedSourceFiles, {
                kinds: ["calls", "renders", "extends", "implements", "imports"],
            });

            const merged = new Map<string, AffectedSymbolEvidence>();

            for (const edge of incoming) {
                // We can only pin to a symbol if the edge has a source symbol.
                if (!edge.sourceSymbol) continue;

                const key = `${edge.sourceFile}::${edge.sourceSymbol}::${edge.targetFile}`;
                const existing = merged.get(key);
                const reason = {
                    reason: edge.kind as AffectedSymbolEvidence["reasons"][number]["reason"],
                    confidence: edge.confidence,
                    line: edge.evidence?.line,
                    snippet: edge.evidence?.snippet,
                };

                if (existing) {
                    existing.reasons.push(reason);
                    existing.confidence = Math.max(existing.confidence, reason.confidence);
                    continue;
                }

                // Look up the actual symbol metadata (range, signature, etc.).
                const symMatches = db.findSymbolsByName(edge.sourceSymbol, { limit: 5 });
                const sym = symMatches.find((m) => m.file === edge.sourceFile)?.symbol;
                if (!sym) continue;

                merged.set(key, {
                    file: edge.sourceFile,
                    symbol: sym,
                    triggeredBy: edge.targetFile,
                    reasons: [reason],
                    confidence: reason.confidence,
                });
            }

            return Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
        } finally {
            db.close();
        }
    }

    /**
     * "Why does Raiken think test X covers ticket Y?" — returns the chain of
     * edges connecting the test to the ticket's changed files.
     *
     * Best-effort: walks one hop. Multi-hop reasoning belongs in a future
     * extension built on top of this service.
     */
    explain(
        testFile: string,
        changedSourceFiles: string[],
    ): {
        testFile: string;
        chains: Array<{
            sourceFile: string;
            edges: GraphEdge[];
        }>;
    } {
        const db = new CodeGraphDB(this.projectPath);
        try {
            const chains: Array<{ sourceFile: string; edges: GraphEdge[] }> = [];

            for (const src of changedSourceFiles) {
                const directEdges = db
                    .getIncomingEdges([src], {
                        kinds: ["calls", "renders", "imports"],
                    })
                    .filter((e) => e.sourceFile === testFile);

                if (directEdges.length > 0) {
                    chains.push({ sourceFile: src, edges: directEdges });
                }
            }

            return { testFile, chains };
        } finally {
            db.close();
        }
    }

    /**
     * Compact, agent-friendly graph summary. Useful for showing the user a
     * trustworthy "your project" snapshot before they ask anything.
     */
    summary(): {
        symbols: number;
        edges: number;
        edgesByKind: Record<string, number>;
    } {
        const db = new CodeGraphDB(this.projectPath);
        try {
            return db.getSymbolGraphStats();
        } finally {
            db.close();
        }
    }
}

export function isLikelyTestPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
        /\.(spec|test|e2e)\.[jt]sx?$/.test(lower) ||
        lower.includes("/tests/") ||
        lower.includes("/test/") ||
        lower.includes("/__tests__/") ||
        lower.includes("/e2e/")
    );
}
