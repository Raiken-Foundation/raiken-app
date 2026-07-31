import type { EdgeKind, EdgeProvenance, GraphEdge, ParsedSymbol, SymbolKind } from "../../types";
import type { DbAdapter } from "../adapter";
import { safeJsonArray, safeJsonObject } from "../utils/json-helpers";

export class SymbolsRepository {
    constructor(private readonly adapter: DbAdapter) {}

    replaceFileSymbols(filePath: string, symbols: ParsedSymbol[]): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                this.replaceFileSymbolsInTransaction(filePath, symbols, Date.now());
            });
            transaction();
        });
    }

    /**
     * Internal helper used inside a larger transaction. Does NOT open its own
     * transaction — caller is responsible for atomicity.
     */
    replaceFileSymbolsInTransaction(filePath: string, symbols: ParsedSymbol[], now: number): void {
        this.adapter.db
            .prepare(`
    DELETE FROM symbols WHERE project_path = ? AND file_path = ?
  `)
            .run(this.adapter.projectPath, filePath);

        if (symbols.length === 0) return;

        const insert = this.adapter.db.prepare(`
    INSERT OR REPLACE INTO symbols (
      project_path, file_path, name, kind, start_line, end_line,
      is_exported, is_async, parent, signature, callees, rendered, route_meta, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

        for (const s of symbols) {
            insert.run(
                this.adapter.projectPath,
                filePath,
                s.name,
                s.kind,
                s.startLine,
                s.endLine,
                s.isExported ? 1 : 0,
                s.isAsync ? 1 : 0,
                s.parent ?? null,
                s.signature ?? null,
                s.callees?.length ? JSON.stringify(s.callees) : null,
                s.rendered?.length ? JSON.stringify(s.rendered) : null,
                s.routeMeta ? JSON.stringify(s.routeMeta) : null,
                now,
            );
        }
    }

    /**
     * Get all symbols defined in a file.
     */
    getFileSymbols(filePath: string): ParsedSymbol[] {
        const rows = this.adapter.db
            .prepare(`
    SELECT name, kind, start_line, end_line, is_exported, is_async, parent, signature, callees, rendered, route_meta
    FROM symbols
    WHERE project_path = ? AND file_path = ?
    ORDER BY start_line ASC
  `)
            .all(this.adapter.projectPath, filePath) as Array<{
            name: string;
            kind: string;
            start_line: number;
            end_line: number;
            is_exported: number;
            is_async: number;
            parent: string | null;
            signature: string | null;
            callees: string | null;
            rendered: string | null;
            route_meta: string | null;
        }>;

        return rows.map((row) => ({
            name: row.name,
            kind: row.kind as SymbolKind,
            startLine: row.start_line,
            endLine: row.end_line,
            isExported: row.is_exported === 1,
            isAsync: row.is_async === 1,
            parent: row.parent ?? undefined,
            signature: row.signature ?? undefined,
            callees: row.callees ? safeJsonArray(row.callees) : undefined,
            rendered: row.rendered ? safeJsonArray(row.rendered) : undefined,
            routeMeta: row.route_meta
                ? safeJsonObject<ParsedSymbol["routeMeta"]>(row.route_meta)
                : undefined,
        }));
    }

    /**
     * Find symbols by name (exact or LIKE), optionally filtered by kind.
     * Useful for resolving "function X is referenced" → which symbol(s) it points to.
     */
    findSymbolsByName(
        name: string,
        opts?: { kinds?: SymbolKind[]; like?: boolean; limit?: number },
    ): Array<{
        file: string;
        symbol: ParsedSymbol;
    }> {
        const limit = opts?.limit ?? 25;
        const op = opts?.like ? "LIKE" : "=";
        const params: Array<string | number> = [this.adapter.projectPath, name];

        let sql = `
    SELECT file_path, name, kind, start_line, end_line, is_exported, is_async, parent, signature, callees, rendered, route_meta
    FROM symbols
    WHERE project_path = ? AND name ${op} ?
  `;

        if (opts?.kinds && opts.kinds.length > 0) {
            const placeholders = opts.kinds.map(() => "?").join(",");
            sql += ` AND kind IN (${placeholders})`;
            params.push(...opts.kinds);
        }

        sql += ` LIMIT ?`;
        params.push(limit);

        const rows = this.adapter.db.prepare(sql).all(...params) as Array<{
            file_path: string;
            name: string;
            kind: string;
            start_line: number;
            end_line: number;
            is_exported: number;
            is_async: number;
            parent: string | null;
            signature: string | null;
            callees: string | null;
            rendered: string | null;
            route_meta: string | null;
        }>;

        return rows.map((row) => ({
            file: row.file_path,
            symbol: {
                name: row.name,
                kind: row.kind as SymbolKind,
                startLine: row.start_line,
                endLine: row.end_line,
                isExported: row.is_exported === 1,
                isAsync: row.is_async === 1,
                parent: row.parent ?? undefined,
                signature: row.signature ?? undefined,
                callees: row.callees ? safeJsonArray(row.callees) : undefined,
                rendered: row.rendered ? safeJsonArray(row.rendered) : undefined,
                routeMeta: row.route_meta
                    ? safeJsonObject<ParsedSymbol["routeMeta"]>(row.route_meta)
                    : undefined,
            },
        }));
    }

    /**
     * Replace all edges originating from a given source file. Idempotent for
     * incremental updates — caller passes the current edges for the file.
     */
    replaceFileEdges(sourceFile: string, edges: GraphEdge[], kinds?: EdgeKind[]): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                this.replaceFileEdgesInTransaction(sourceFile, edges, Date.now(), kinds);
            });
            transaction();
        });
    }

    replaceFileEdgesInTransaction(
        sourceFile: string,
        edges: GraphEdge[],
        now: number,
        kinds?: EdgeKind[],
    ): void {
        // By default we replace every static_ast edge originating from this file.
        // Runtime/test_run edges live alongside and are NOT touched here.
        if (kinds && kinds.length > 0) {
            const placeholders = kinds.map(() => "?").join(",");
            this.adapter.db
                .prepare(`
      DELETE FROM graph_edges
      WHERE project_path = ? AND source_file = ? AND kind IN (${placeholders}) AND provenance = 'static_ast'
    `)
                .run(this.adapter.projectPath, sourceFile, ...kinds);
        } else {
            this.adapter.db
                .prepare(`
      DELETE FROM graph_edges WHERE project_path = ? AND source_file = ? AND provenance = 'static_ast'
    `)
                .run(this.adapter.projectPath, sourceFile);
        }

        if (edges.length === 0) return;

        const insert = this.adapter.db.prepare(`
    INSERT INTO graph_edges (
      project_path, kind, source_file, target_file, source_symbol, target_symbol,
      provenance, confidence, evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

        for (const e of edges) {
            insert.run(
                this.adapter.projectPath,
                e.kind,
                e.sourceFile,
                e.targetFile,
                e.sourceSymbol ?? null,
                e.targetSymbol ?? null,
                e.provenance,
                e.confidence,
                e.evidence ? JSON.stringify(e.evidence) : null,
                now,
            );
        }
    }

    /**
     * Add edges without removing existing ones. Used by runtime/coverage feedback.
     */
    addEdges(edges: GraphEdge[]): void {
        if (edges.length === 0) return;
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const insert = this.adapter.db.prepare(`
        INSERT INTO graph_edges (
          project_path, kind, source_file, target_file, source_symbol, target_symbol,
          provenance, confidence, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
                const now = Date.now();
                for (const e of edges) {
                    insert.run(
                        this.adapter.projectPath,
                        e.kind,
                        e.sourceFile,
                        e.targetFile,
                        e.sourceSymbol ?? null,
                        e.targetSymbol ?? null,
                        e.provenance,
                        e.confidence,
                        e.evidence ? JSON.stringify(e.evidence) : null,
                        now,
                    );
                }
            });
            transaction();
        });
    }

    /**
     * Find edges that target any of the given files. Used to resolve
     * "what depends on these changed files" with explicit provenance.
     */
    getIncomingEdges(targetFiles: string[], opts?: { kinds?: EdgeKind[] }): GraphEdge[] {
        if (targetFiles.length === 0) return [];

        const placeholders = targetFiles.map(() => "?").join(",");
        let sql = `
    SELECT kind, source_file, target_file, source_symbol, target_symbol, provenance, confidence, evidence
    FROM graph_edges
    WHERE project_path = ? AND target_file IN (${placeholders})
  `;
        const params: Array<string | number> = [this.adapter.projectPath, ...targetFiles];

        if (opts?.kinds && opts.kinds.length > 0) {
            const kindPlaceholders = opts.kinds.map(() => "?").join(",");
            sql += ` AND kind IN (${kindPlaceholders})`;
            params.push(...opts.kinds);
        }

        sql += ` ORDER BY confidence DESC`;

        const rows = this.adapter.db.prepare(sql).all(...params) as Array<{
            kind: string;
            source_file: string;
            target_file: string;
            source_symbol: string | null;
            target_symbol: string | null;
            provenance: string;
            confidence: number;
            evidence: string | null;
        }>;

        return rows.map((row) => ({
            kind: row.kind as EdgeKind,
            sourceFile: row.source_file,
            targetFile: row.target_file,
            sourceSymbol: row.source_symbol ?? undefined,
            targetSymbol: row.target_symbol ?? undefined,
            provenance: row.provenance as EdgeProvenance,
            confidence: row.confidence,
            evidence: row.evidence
                ? safeJsonObject<GraphEdge["evidence"]>(row.evidence)
                : undefined,
        }));
    }

    /**
     * Compact stats for the symbol graph (used by `raiken status` / dashboard).
     */
    getSymbolGraphStats(): { symbols: number; edges: number; edgesByKind: Record<string, number> } {
        const sym = this.adapter.db
            .prepare(`SELECT COUNT(*) as c FROM symbols WHERE project_path = ?`)
            .get(this.adapter.projectPath) as { c: number };
        const edg = this.adapter.db
            .prepare(`SELECT COUNT(*) as c FROM graph_edges WHERE project_path = ?`)
            .get(this.adapter.projectPath) as { c: number };
        const byKind = this.adapter.db
            .prepare(`
    SELECT kind, COUNT(*) as c FROM graph_edges WHERE project_path = ? GROUP BY kind
  `)
            .all(this.adapter.projectPath) as Array<{ kind: string; c: number }>;

        return {
            symbols: sym.c,
            edges: edg.c,
            edgesByKind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
        };
    }
}
