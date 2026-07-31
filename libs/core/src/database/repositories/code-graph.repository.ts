import * as path from "node:path";
import { buildEdgesForNode } from "../../analysis/symbol-extractor";
import type {
    CodeNode,
    DBDependency,
    DBEntryPoint,
    DBFileNode,
    DBStats,
    ParsedFile,
} from "../../types";
import type { DbAdapter } from "../adapter";
import { SCHEMA_VERSION } from "../constants";
import type { SymbolsRepository } from "./symbols.repository";

/**
 * Upsert that preserves `files.id`.
 *
 * `INSERT OR REPLACE` would delete the conflicting row and insert a new one
 * with a fresh autoincrement id, which cascades away that file's embeddings
 * and strands its `vec_embeddings` rows (a virtual table gets no FK cascade).
 */
const UPSERT_FILE_SQL = `
    INSERT INTO files (
      project_path, file_path, relative_path, content_hash, tree_hash,
      size, lines, depth, last_indexed, functions_count, classes_count,
      types_count, imports_count, exported_count, parsed_ast, ast, indexed_via
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_path, file_path) DO UPDATE SET
      relative_path = excluded.relative_path,
      content_hash = excluded.content_hash,
      tree_hash = excluded.tree_hash,
      size = excluded.size,
      lines = excluded.lines,
      depth = excluded.depth,
      last_indexed = excluded.last_indexed,
      functions_count = excluded.functions_count,
      classes_count = excluded.classes_count,
      types_count = excluded.types_count,
      imports_count = excluded.imports_count,
      exported_count = excluded.exported_count,
      parsed_ast = excluded.parsed_ast,
      ast = excluded.ast,
      indexed_via = excluded.indexed_via
`;

export class CodeGraphRepository {
    constructor(
        private readonly adapter: DbAdapter,
        private readonly symbols: SymbolsRepository,
    ) {}

    /**
     * Drop a file's embeddings from both the main table and the vector table.
     * Must run inside a transaction owned by the caller.
     */
    private purgeEmbeddingsInTransaction(filePath: string): void {
        const embeddingIds = (
            this.adapter.db
                .prepare(`
        SELECT e.id FROM embeddings e
        JOIN files f ON e.file_id = f.id
        WHERE f.project_path = ? AND f.file_path = ?
      `)
                .all(this.adapter.projectPath, filePath) as Array<{ id: number }>
        ).map((row) => row.id);

        if (embeddingIds.length === 0) return;

        const deleteVec = this.adapter.db.prepare(`DELETE FROM vec_embeddings WHERE rowid = ?`);
        const deleteEmbedding = this.adapter.db.prepare(`DELETE FROM embeddings WHERE id = ?`);
        for (const id of embeddingIds) {
            deleteVec.run(id);
            deleteEmbedding.run(id);
        }
    }

    saveGraph(
        nodes: Map<string, CodeNode>,
        entryPoints: Array<{ file: string; framework?: string; role: string; type: string }>,
        indexedVia: "scan" | "watch" = "scan",
    ): { skippedFiles: Array<{ path: string; reason: string }> } {
        const skippedFiles: Array<{ path: string; reason: string }> = [];
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const now = Date.now();
                // Reset in case this is a retry attempt (SQLITE_BUSY) re-running
                // the whole transaction from scratch — avoid double-counting.
                skippedFiles.length = 0;

                // ✅ Only clear data that matches the indexing method
                if (indexedVia === "scan") {
                    this.clearProject();
                }

                // ✅ Prepare statements once
                const insertFile = this.adapter.db.prepare(UPSERT_FILE_SQL);

                const insertDep = this.adapter.db.prepare(`
        INSERT OR REPLACE INTO dependencies (project_path, source_file, target_file, import_type, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

                const insertEntry = this.adapter.db.prepare(`
        INSERT OR REPLACE INTO entry_points (project_path, file_path, framework, role, type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

                // ✅ Single-pass stats calculation
                let totalSize = 0;
                let totalLines = 0;
                let totalFunctions = 0;
                let totalClasses = 0;
                let totalTypes = 0;

                // Insert files with full AST data. Each file is isolated in
                // its own try/catch — a single pathological file (oversized
                // AST that blows V8's string length limit, an unexpected
                // constraint violation, etc) must skip that file, not roll
                // back the entire scan via the enclosing transaction.
                for (const [filePath, node] of nodes.entries()) {
                    try {
                        // ✅ Serialize full AST data
                        let parsedAst: string;
                        let ast: string | null;
                        try {
                            parsedAst = JSON.stringify(node.parsed);
                            ast = node.ast ? JSON.stringify(node.ast) : null;
                        } catch (serializeError) {
                            // Fall back to storing the file without its AST
                            // rather than losing it (and everything after it
                            // in iteration order) entirely.
                            console.warn(
                                `[CodeGraphDB] Could not serialize AST for "${node.relativePath}" — storing without AST: ${
                                    serializeError instanceof Error
                                        ? serializeError.message
                                        : String(serializeError)
                                }`,
                            );
                            parsedAst = JSON.stringify({
                                functions: [],
                                classes: [],
                                imports: [],
                                exports: [],
                                types: [],
                            });
                            ast = null;
                        }

                        insertFile.run(
                            this.adapter.projectPath,
                            filePath,
                            node.relativePath,
                            node.hash,
                            node.treeHash,
                            node.size,
                            node.lines,
                            node.depth,
                            now,
                            node.parsed.functions.length,
                            node.parsed.classes.length,
                            node.parsed.types.length,
                            node.imports.length,
                            node.parsed.exports.length,
                            parsedAst,
                            ast,
                            indexedVia,
                        );

                        // Insert dependencies with type classification
                        for (const targetFile of node.imports) {
                            // Determine import type from parsed data
                            const importInfo = node.parsed.imports.find((imp) => {
                                // Match by source path (approximate - would need resolution)
                                return targetFile.includes(imp.source.replace(/^\.\//, ""));
                            });
                            const importType = importInfo?.isTypeOnly ? "type-only" : "static";

                            insertDep.run(
                                this.adapter.projectPath,
                                filePath,
                                targetFile,
                                importType,
                                now,
                            );
                        }

                        // Persist symbol-level data and unified edges for this file.
                        if (node.symbols && node.symbols.length > 0) {
                            this.symbols.replaceFileSymbolsInTransaction(
                                filePath,
                                node.symbols,
                                now,
                            );
                        }
                        const edges = buildEdgesForNode(node, node.intraFileEdges ?? []);
                        if (edges.length > 0) {
                            this.symbols.replaceFileEdgesInTransaction(filePath, edges, now);
                        }

                        // ✅ Calculate stats in same loop, only for files that
                        // actually made it into the DB.
                        totalSize += node.size;
                        totalLines += node.lines;
                        totalFunctions += node.parsed.functions.length;
                        totalClasses += node.parsed.classes.length;
                        totalTypes += node.parsed.types.length;
                    } catch (fileError) {
                        const reason =
                            fileError instanceof Error ? fileError.message : String(fileError);
                        skippedFiles.push({ path: node.relativePath, reason });
                        console.warn(
                            `[CodeGraphDB] Skipping "${node.relativePath}" — failed to save to the code graph: ${reason}`,
                        );
                    }
                }

                // Insert entry points
                for (const entryPoint of entryPoints) {
                    insertEntry.run(
                        this.adapter.projectPath,
                        entryPoint.file,
                        entryPoint.framework || null,
                        entryPoint.role,
                        entryPoint.type,
                        now,
                    );
                }

                // Save stats with schema version
                this.adapter.db
                    .prepare(`
        INSERT OR REPLACE INTO stats (
          project_path, total_files, total_size, total_lines,
          total_functions, total_classes, total_types, last_scan, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
                    .run(
                        this.adapter.projectPath,
                        nodes.size - skippedFiles.length,
                        totalSize,
                        totalLines,
                        totalFunctions,
                        totalClasses,
                        totalTypes,
                        now,
                        SCHEMA_VERSION,
                    );
            });

            transaction();
        });

        return { skippedFiles };
    }

    /**
     * Upsert a single file (for incremental updates).
     */
    upsertFile(node: CodeNode, indexedVia: "scan" | "watch" = "watch"): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const now = Date.now();

                // Delete old dependencies for this file
                this.adapter.db
                    .prepare(`
        DELETE FROM dependencies WHERE project_path = ? AND source_file = ?
      `)
                    .run(this.adapter.projectPath, node.filePath);

                // Upsert file with both parsed structure and complete AST
                const parsedAst = JSON.stringify(node.parsed);
                const ast = node.ast ? JSON.stringify(node.ast) : null;

                // Embeddings describe the previous contents. Drop them (from both
                // tables) only when the file actually changed, so an unchanged
                // re-index keeps its vectors instead of silently losing them.
                if (this.hasFileChanged(node.filePath, node.hash)) {
                    this.purgeEmbeddingsInTransaction(node.filePath);
                }

                this.adapter.db
                    .prepare(UPSERT_FILE_SQL)
                    .run(
                        this.adapter.projectPath,
                        node.filePath,
                        node.relativePath,
                        node.hash,
                        node.treeHash,
                        node.size,
                        node.lines,
                        node.depth,
                        now,
                        node.parsed.functions.length,
                        node.parsed.classes.length,
                        node.parsed.types.length,
                        node.imports.length,
                        node.parsed.exports.length,
                        parsedAst,
                        ast,
                        indexedVia,
                    );

                // Insert new dependencies
                const insertDep = this.adapter.db.prepare(`
        INSERT OR REPLACE INTO dependencies (project_path, source_file, target_file, import_type, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

                for (const targetFile of node.imports) {
                    insertDep.run(
                        this.adapter.projectPath,
                        node.filePath,
                        targetFile,
                        "static",
                        now,
                    );
                }

                // Persist symbol-level data and unified edges for this file.
                if (node.symbols && node.symbols.length > 0) {
                    this.symbols.replaceFileSymbolsInTransaction(node.filePath, node.symbols, now);
                } else {
                    // Even if there are no symbols (e.g. binary or parse failure), make
                    // sure we don't leave stale rows behind.
                    this.adapter.db
                        .prepare(`
          DELETE FROM symbols WHERE project_path = ? AND file_path = ?
        `)
                        .run(this.adapter.projectPath, node.filePath);
                }

                const edges = buildEdgesForNode(node, node.intraFileEdges ?? []);
                this.symbols.replaceFileEdgesInTransaction(node.filePath, edges, now);

                // Recalculate stats
                this.recalculateStats();
            });

            transaction();
        });
    }

    /**
     * Remove a file from the database.
     */
    removeFile(filePath: string): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                // Clean vec_embeddings before deleting the file (no FK cascade on virtual table)
                const embeddingIds = (
                    this.adapter.db
                        .prepare(`
        SELECT e.id FROM embeddings e
        JOIN files f ON e.file_id = f.id
        WHERE f.project_path = ? AND f.file_path = ?
      `)
                        .all(this.adapter.projectPath, filePath) as Array<{ id: number }>
                ).map((r) => r.id);

                if (embeddingIds.length > 0) {
                    const deleteVec = this.adapter.db.prepare(
                        `DELETE FROM vec_embeddings WHERE rowid = ?`,
                    );
                    for (const id of embeddingIds) {
                        deleteVec.run(id);
                    }
                }

                this.adapter.db
                    .prepare(`DELETE FROM files WHERE project_path = ? AND file_path = ?`)
                    .run(this.adapter.projectPath, filePath);
                this.adapter.db
                    .prepare(
                        `DELETE FROM dependencies WHERE project_path = ? AND (source_file = ? OR target_file = ?)`,
                    )
                    .run(this.adapter.projectPath, filePath, filePath);
                this.adapter.db
                    .prepare(`DELETE FROM symbols WHERE project_path = ? AND file_path = ?`)
                    .run(this.adapter.projectPath, filePath);
                this.adapter.db
                    .prepare(
                        `DELETE FROM graph_edges WHERE project_path = ? AND (source_file = ? OR target_file = ?)`,
                    )
                    .run(this.adapter.projectPath, filePath, filePath);
                this.recalculateStats();
            });

            transaction();
        });
    }

    /**
     * Recalculate project stats from current files.
     */
    recalculateStats(): void {
        const stats = this.adapter.db
            .prepare(`
    SELECT 
      COUNT(*) as total_files,
      SUM(size) as total_size,
      SUM(lines) as total_lines,
      SUM(functions_count) as total_functions,
      SUM(classes_count) as total_classes,
      SUM(types_count) as total_types
    FROM files WHERE project_path = ?
  `)
            .get(this.adapter.projectPath) as {
            total_files: number;
            total_size: number;
            total_lines: number;
            total_functions: number;
            total_classes: number;
            total_types: number;
        };

        this.adapter.db
            .prepare(`
    INSERT OR REPLACE INTO stats (
      project_path, total_files, total_size, total_lines,
      total_functions, total_classes, total_types, last_scan, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
            .run(
                this.adapter.projectPath,
                stats.total_files || 0,
                stats.total_size || 0,
                stats.total_lines || 0,
                stats.total_functions || 0,
                stats.total_classes || 0,
                stats.total_types || 0,
                Date.now(),
                SCHEMA_VERSION,
            );
    }

    // ==========================================================================
    // Load Operations
    // ==========================================================================

    /**
     * Load the complete graph from the database.
     * ✅ Now includes full AST data!
     */
    loadGraph(): { nodes: Map<string, CodeNode>; entryPoints: DBEntryPoint[] } | null {
        const stats = this.getStats();
        if (!stats) return null;

        const nodes = new Map<string, CodeNode>();

        // Load files with parsed AST
        const files = this.adapter.db
            .prepare(`
    SELECT * FROM files WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as DBFileNode[];

        for (const file of files) {
            // ✅ Parse stored AST JSON
            let parsed: ParsedFile;
            try {
                parsed = JSON.parse(file.parsed_ast || "{}") as ParsedFile;
                // Ensure all arrays exist
                parsed.functions = parsed.functions || [];
                parsed.classes = parsed.classes || [];
                parsed.imports = parsed.imports || [];
                parsed.exports = parsed.exports || [];
                parsed.types = parsed.types || [];
            } catch {
                parsed = { functions: [], classes: [], imports: [], exports: [], types: [] };
            }

            let ast: unknown | undefined;
            try {
                ast = file.ast ? JSON.parse(file.ast) : undefined;
            } catch {
                ast = undefined;
            }

            nodes.set(file.file_path, {
                filePath: file.file_path,
                relativePath: file.relative_path,
                hash: file.content_hash,
                treeHash: file.tree_hash,
                size: file.size,
                lines: file.lines,
                depth: file.depth,
                imports: [],
                importedBy: [],
                lastModified: file.last_indexed,
                parsed,
                ast,
                meta: {
                    extension: path.extname(file.file_path),
                    isTest: /\.(test|spec)\.[jt]sx?$/.test(file.file_path),
                    isEntry: false,
                    hasExports: parsed.exports.length > 0,
                    hasDefaultExport: parsed.exports.includes("default"),
                    complexity: parsed.functions.length + parsed.classes.length,
                },
            });
        }

        // Load dependencies
        const deps = this.adapter.db
            .prepare(`
    SELECT * FROM dependencies WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as DBDependency[];

        for (const dep of deps) {
            const sourceNode = nodes.get(dep.source_file);
            const targetNode = nodes.get(dep.target_file);

            if (sourceNode) {
                sourceNode.imports.push(dep.target_file);
            }
            if (targetNode) {
                targetNode.importedBy.push(dep.source_file);
            }
        }

        // Load entry points and mark files
        const entryPoints = this.adapter.db
            .prepare(`
    SELECT * FROM entry_points WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as DBEntryPoint[];

        for (const ep of entryPoints) {
            const node = nodes.get(ep.file_path);
            if (node) {
                node.meta.isEntry = true;
            }
        }

        return { nodes, entryPoints };
    }

    /**
     * Get statistics for this project.
     */
    getStats(): DBStats | null {
        const stats = this.adapter.db
            .prepare(`
    SELECT * FROM stats WHERE project_path = ?
  `)
            .get(this.adapter.projectPath);

        return stats as DBStats | null;
    }

    /**
     * Get all files in this project.
     */
    getFiles(): DBFileNode[] {
        return this.adapter.db
            .prepare(`
    SELECT * FROM files WHERE project_path = ?
    ORDER BY relative_path
  `)
            .all(this.adapter.projectPath) as DBFileNode[];
    }

    /**
     * ✅ Stream files for large datasets (memory efficient)
     */
    *streamFiles(): Generator<DBFileNode> {
        const stmt = this.adapter.db.prepare(`
    SELECT * FROM files WHERE project_path = ?
    ORDER BY relative_path
  `);

        for (const row of stmt.iterate(this.adapter.projectPath)) {
            yield row as DBFileNode;
        }
    }

    /**
     * Get a single file by path.
     */
    getFile(filePath: string): DBFileNode | null {
        const file = this.adapter.db
            .prepare(`
    SELECT * FROM files WHERE project_path = ? AND file_path = ?
  `)
            .get(this.adapter.projectPath, filePath);

        return file as DBFileNode | null;
    }

    /**
     * Get a file by its relative path.
     */
    getFileByRelativePath(relativePath: string): DBFileNode | null {
        const file = this.adapter.db
            .prepare(`
    SELECT * FROM files WHERE project_path = ? AND relative_path = ?
  `)
            .get(this.adapter.projectPath, relativePath);

        return file as DBFileNode | null;
    }

    /**
     * Get dependencies for a specific file.
     */
    getDependencies(filePath: string): DBDependency[] {
        return this.adapter.db
            .prepare(`
    SELECT * FROM dependencies
    WHERE project_path = ? AND source_file = ?
  `)
            .all(this.adapter.projectPath, filePath) as DBDependency[];
    }

    /**
     * Get dependents (files that import this file).
     */
    getDependents(filePath: string): DBDependency[] {
        return this.adapter.db
            .prepare(`
    SELECT * FROM dependencies
    WHERE project_path = ? AND target_file = ?
  `)
            .all(this.adapter.projectPath, filePath) as DBDependency[];
    }

    /**
     * Get entry points for this project.
     */
    getEntryPoints(): DBEntryPoint[] {
        return this.adapter.db
            .prepare(`
    SELECT * FROM entry_points WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as DBEntryPoint[];
    }

    /**
     * Check if a file exists in the database.
     */
    hasFile(filePath: string): boolean {
        const result = this.adapter.db
            .prepare(`
    SELECT 1 FROM files WHERE project_path = ? AND file_path = ?
  `)
            .get(this.adapter.projectPath, filePath);

        return result !== undefined;
    }

    /**
     * Check if a file's hash has changed.
     */
    hasFileChanged(filePath: string, newHash: string): boolean {
        const file = this.getFile(filePath);
        return !file || file.content_hash !== newHash;
    }

    clearProject(): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                // Clean vec_embeddings before deleting files (no FK cascade on virtual table)
                const embeddingIds = (
                    this.adapter.db
                        .prepare(`
        SELECT e.id FROM embeddings e
        JOIN files f ON e.file_id = f.id
        WHERE f.project_path = ?
      `)
                        .all(this.adapter.projectPath) as Array<{ id: number }>
                ).map((r) => r.id);

                if (embeddingIds.length > 0) {
                    const deleteVec = this.adapter.db.prepare(
                        `DELETE FROM vec_embeddings WHERE rowid = ?`,
                    );
                    for (const id of embeddingIds) {
                        deleteVec.run(id);
                    }
                }

                this.adapter.db
                    .prepare("DELETE FROM files WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                this.adapter.db
                    .prepare("DELETE FROM dependencies WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                this.adapter.db
                    .prepare("DELETE FROM entry_points WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                this.adapter.db
                    .prepare("DELETE FROM stats WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                this.adapter.db
                    .prepare("DELETE FROM symbols WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                this.adapter.db
                    .prepare("DELETE FROM graph_edges WHERE project_path = ?")
                    .run(this.adapter.projectPath);
                // keyword_index is keyed by project_path rather than files.id, so it
                // gets no cascade — without this a full rescan leaves keywords
                // pointing at files that are no longer in the graph.
                this.adapter.db
                    .prepare("DELETE FROM keyword_index WHERE project_path = ?")
                    .run(this.adapter.projectPath);
            });

            transaction();
        });
    }

    /**
     * Files re-indexed since `sinceTimestamp`, with the hash recorded at that
     * point. Re-indexing bumps `last_indexed` whether or not the bytes changed,
     * so compare `contentHash` against the current file to detect a real edit.
     */
    getChangedFilesSince(sinceTimestamp: number): Array<{
        path: string;
        lastIndexed: number;
        contentHash: string;
    }> {
        const rows = this.adapter.db
            .prepare(`
    SELECT relative_path, last_indexed, content_hash
    FROM files 
    WHERE project_path = ? AND last_indexed > ?
    ORDER BY last_indexed DESC
  `)
            .all(this.adapter.projectPath, sinceTimestamp) as Array<{
            relative_path: string;
            last_indexed: number;
            content_hash: string;
        }>;

        return rows.map((row) => ({
            path: row.relative_path,
            lastIndexed: row.last_indexed,
            contentHash: row.content_hash,
        }));
    }

    /**
     * Get the last scan time for this project.
     */
    getLastScanTime(): number {
        const stats = this.getStats();
        return stats?.last_scan || 0;
    }
}
