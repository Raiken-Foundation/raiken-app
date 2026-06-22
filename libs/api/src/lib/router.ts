// libs/api/src/lib/router.ts

import * as path from "node:path";
import {
    CodeGraph,
    CodeGraphDB,
    EmbeddingsGenerator,
    EntryPointDetector,
    formatBytes,
    fullAstToSearchableText,
} from "@raiken/core";
import { initTRPC } from "@trpc/server";
import { z } from "zod";

// Context type for tRPC procedures
export interface Context {
    projectPath: string;
}

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return {
            status: "ok",
            engine: "raiken",
            version: "0.0.1",
        };
    }),

    getProjectInfo: t.procedure.query(async ({ ctx }) => {
        return {
            path: ctx.projectPath,
            nodeVersion: process.version,
        };
    }),

    buildCodeGraph: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                includeTests: z.boolean().default(false),
                extensions: z.array(z.string()).optional(),
                useGitignore: z.boolean().default(true),
                persist: z.boolean().default(true),
            }),
        )
        .mutation(async ({ input }) => {
            const projectPath = input.path || process.cwd();

            // Detect entry points
            const detector = new EntryPointDetector(projectPath);
            const entryPoints = await detector.detectEntryPoints();

            // Build code graph
            const graph = new CodeGraph(projectPath, {
                includeTests: input.includeTests,
                extensions: input.extensions,
                useGitignore: input.useGitignore,
                maxDepth: 15,
            });

            // Use entry points if available, otherwise scan entire project
            if (entryPoints.length > 0) {
                await graph.initialize(entryPoints.map((ep) => ep.file));
            } else {
                await graph.scanProject();
            }

            const stats = graph.getStats();
            const allFiles = graph.getAllFiles();

            const totalSize = allFiles.reduce((sum, node) => sum + node.size, 0);
            const totalLines = allFiles.reduce((sum, node) => sum + node.lines, 0);

            // Persist to database if requested
            if (input.persist) {
                const db = new CodeGraphDB(projectPath);
                const nodes = new Map();
                for (const node of allFiles) {
                    nodes.set(node.filePath, node);
                }
                // Map entry points to database format
                const dbEntryPoints = entryPoints.map((ep) => ({
                    file: ep.file,
                    framework: ep.framework,
                    role: ep.role || "main",
                    type: ep.type,
                }));
                db.saveGraph(nodes, dbEntryPoints);
                db.close();
            }

            // Return graph structure with linkages
            return {
                projectRoot: projectPath,
                entryPoints: entryPoints.map((ep) => ({
                    file: path.relative(projectPath, ep.file),
                    framework: ep.framework,
                    role: ep.role,
                    type: ep.type,
                })),
                stats,
                totalSize,
                totalLines,
                totalSizeFormatted: formatBytes(totalSize),
                files: allFiles.map((node) => ({
                    path: node.relativePath,
                    depth: node.depth,
                    functions: node.parsed.functions.length,
                    classes: node.parsed.classes.length,
                    types: node.parsed.types.length,
                    size: node.size,
                    lines: node.lines,
                    imports: node.imports.map((imp) => path.relative(projectPath, imp)),
                    importedBy: node.importedBy.map((imp) => path.relative(projectPath, imp)),
                })),
            };
        }),

    getGraphStats: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const stats = db.getStats();
            db.close();

            if (!stats) {
                return null;
            }

            return {
                projectPath: stats.project_path,
                totalFiles: stats.total_files,
                totalSize: stats.total_size,
                totalSizeFormatted: formatBytes(stats.total_size),
                totalLines: stats.total_lines,
                totalFunctions: stats.total_functions,
                totalClasses: stats.total_classes,
                totalTypes: stats.total_types,
                lastScan: new Date(stats.last_scan).toISOString(),
            };
        }),

    getGraphFiles: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(100),
                offset: z.number().default(0),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const allFiles = db.getFiles();
            db.close();

            const paginated = allFiles.slice(input.offset, input.offset + input.limit);

            return {
                total: allFiles.length,
                files: paginated.map((file) => ({
                    path: file.relative_path,
                    size: file.size,
                    sizeFormatted: formatBytes(file.size),
                    lines: file.lines,
                    depth: file.depth,
                    functions: file.functions_count,
                    classes: file.classes_count,
                    types: file.types_count,
                    imports: file.imports_count,
                    exports: file.exported_count,
                    contentHash: file.content_hash,
                    treeHash: file.tree_hash,
                    lastIndexed: new Date(file.last_indexed).toISOString(),
                })),
                hasMore: input.offset + input.limit < allFiles.length,
            };
        }),

    getFileDependencies: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                filePath: z.string(),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);

            const dependencies = db.getDependencies(path.join(projectPath, input.filePath));
            const dependents = db.getDependents(path.join(projectPath, input.filePath));

            db.close();

            return {
                filePath: input.filePath,
                imports: dependencies.map((dep) => path.relative(projectPath, dep.target_file)),
                importedBy: dependents.map((dep) => path.relative(projectPath, dep.source_file)),
                timestamp: new Date().toISOString(),
            };
        }),

    getFileContent: t.procedure
        .input(
            z.object({
                filePath: z.string(),
            }),
        )
        .query(async ({ input }) => {
            const projectPath = process.cwd();
            const fullPath = path.join(projectPath, input.filePath);

            try {
                const fs = await import("node:fs/promises");
                const content = await fs.readFile(fullPath, "utf-8");
                return {
                    filePath: input.filePath,
                    content,
                    timestamp: new Date().toISOString(),
                };
            } catch {
                throw new Error(`Failed to read file: ${input.filePath}`);
            }
        }),

    // ============================================================================
    // Database Viewer Endpoints
    // ============================================================================

    getDatabaseTables: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);

            const tables = db.getTables();

            db.close();

            return {
                tables: tables.map((table) => ({
                    name: table.name,
                    rowCount: table.row_count || 0,
                })),
                timestamp: new Date().toISOString(),
            };
        }),

    getTableData: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                table: z.string(),
                limit: z.number().default(50),
                offset: z.number().default(0),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);

            const data = db.queryTable(input.table, input.limit, input.offset);
            const total = db.getTableCount(input.table);

            db.close();

            return {
                table: input.table,
                data,
                total,
                limit: input.limit,
                offset: input.offset,
                hasMore: input.offset + input.limit < total,
            };
        }),

    executeQuery: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                query: z.string(),
                params: z.array(z.any()).optional(),
            }),
        )
        .mutation(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);

            try {
                const results = db.executeQuery(input.query, input.params || []);
                db.close();

                return {
                    success: true,
                    results,
                    rowCount: Array.isArray(results) ? results.length : 0,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    error: error instanceof Error ? error.message : "Unknown error",
                    results: [],
                    rowCount: 0,
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    // ============================================================================
    // Embeddings & Semantic Search Endpoints
    // ============================================================================

    generateEmbeddings: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                forceRegenerate: z.boolean().default(false),
            }),
        )
        .mutation(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const embGen = EmbeddingsGenerator.getInstance();

            try {
                // Initialize model
                await embGen.initialize();

                // Get all files from database
                const files = db.getFiles();
                let totalChunks = 0;
                let filesProcessed = 0;

                console.log(`🔄 Generating embeddings for ${files.length} files...`);

                for (const file of files) {
                    // Skip if embeddings already exist and not forcing regeneration
                    if (!input.forceRegenerate && db.hasEmbeddings(file.id)) {
                        continue;
                    }

                    // Use full AST for richer embeddings (needed for test generation)
                    if (!file.ast) {
                        console.warn(`⚠️  No AST data for ${file.relative_path}, skipping`);
                        continue;
                    }

                    // Parse stored full AST
                    let ast;
                    try {
                        ast = JSON.parse(file.ast);
                    } catch {
                        console.warn(`⚠️  Failed to parse AST for ${file.relative_path}, skipping`);
                        continue;
                    }

                    // Convert full AST to rich searchable text
                    const searchableText = fullAstToSearchableText(ast, file.relative_path);

                    // Skip if no content
                    if (!searchableText || searchableText.trim().length === 0) {
                        continue;
                    }

                    // For now, embed the entire file as one chunk
                    // Future: Can split into semantic chunks based on AST nodes
                    const chunks = [
                        {
                            type: "file" as const,
                            name: file.relative_path,
                            text: searchableText,
                        },
                    ];

                    // Generate embeddings
                    const texts = chunks.map((c) => c.text);
                    const embeddings = await embGen.generateEmbeddingsBatch(texts);

                    // Store in database
                    const chunksWithEmbeddings = chunks.map((chunk, i) => ({
                        ...chunk,
                        embedding: embeddings[i],
                    }));

                    db.saveEmbeddings(file.id, chunksWithEmbeddings);
                    totalChunks += chunks.length;
                    filesProcessed++;

                    if (filesProcessed % 10 === 0) {
                        console.log(`  Progress: ${filesProcessed}/${files.length} files`);
                    }
                }

                db.close();

                return {
                    success: true,
                    filesProcessed,
                    totalFiles: files.length,
                    chunksGenerated: totalChunks,
                    modelUsed: "Xenova/all-MiniLM-L6-v2",
                    embeddingDimension: 384,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    error: error instanceof Error ? error.message : "Unknown error",
                    filesProcessed: 0,
                    totalFiles: 0,
                    chunksGenerated: 0,
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    searchCode: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                query: z.string(),
                limit: z.number().default(10),
                chunkTypes: z.array(z.enum(["function", "class", "file", "type"])).optional(),
            }),
        )
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const embGen = EmbeddingsGenerator.getInstance();

            try {
                // Check if embeddings exist
                const embeddingsCount = db.getEmbeddingsCount();
                if (embeddingsCount === 0) {
                    db.close();
                    return {
                        query: input.query,
                        results: [],
                        message: "No embeddings found. Please run generateEmbeddings first.",
                        timestamp: new Date().toISOString(),
                    };
                }

                // Generate embedding for query
                await embGen.initialize();
                const queryEmbedding = await embGen.generateEmbedding(input.query);

                // Search database
                const results = db.searchSimilar(queryEmbedding, input.limit, input.chunkTypes);

                db.close();

                return {
                    query: input.query,
                    results: results.map((r) => ({
                        filePath: r.filePath,
                        chunkType: r.chunkType,
                        chunkName: r.chunkName,
                        chunkText: r.chunkText,
                        similarity: r.similarity,
                        relevanceScore: Math.round(r.similarity * 100),
                    })),
                    totalResults: results.length,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    query: input.query,
                    results: [],
                    error: error instanceof Error ? error.message : "Unknown error",
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    getEmbeddingsStats: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);

            const totalEmbeddings = db.getEmbeddingsCount();
            const totalFiles = db.getStats()?.total_files || 0;

            db.close();

            return {
                totalEmbeddings,
                totalFiles,
                embeddingsPerFile: totalFiles > 0 ? (totalEmbeddings / totalFiles).toFixed(2) : "0",
                modelUsed: "Xenova/all-MiniLM-L6-v2",
                embeddingDimension: 384,
                timestamp: new Date().toISOString(),
            };
        }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
