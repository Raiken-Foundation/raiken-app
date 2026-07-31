import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAIConfig } from "../agent/ai-providers";
import { fullAstToSearchableText } from "../analysis/ast-parser";
import { CodeGraph } from "../analysis/code-graph";
import { EntryPointDetector } from "../analysis/entry-points";
import { ProjectContext } from "../analysis/project-context";
import { loadIntegrationsConfig } from "../config";
import { CodeGraphDB } from "../database/db";
import { EmbeddingsGenerator } from "../database/embeddings";
import { notFoundError } from "../errors";
import { getCurrentBranch, parseTicketFromBranch } from "../integrations/branch-parser";
import { syncCurrentTicket } from "../integrations/sync";
import { formatBytes } from "../utils";
import type { ProjectApplicationContext } from "./context";
import { assertUnderProjectRoot } from "./paths";

/**
 * Cosine similarity runs [-1, 1]; a NEGATIVE score means the chunk is
 * anti-correlated with the query — noise, not a match. Ranking by distance
 * can still surface such rows when the index is small, and the CLI then
 * renders nonsense like "-4% playwright.config.ts". Filter them out and
 * clamp the survivors so the displayed pair stays within [0, 1] / [0, 100].
 */
export function toRelevanceResult(r: {
    similarity: number;
}): { similarity: number; relevanceScore: number } | null {
    if (!(r.similarity > 0)) return null;
    const similarity = Math.min(1, r.similarity);
    return { similarity, relevanceScore: Math.round(similarity * 100) };
}

/** Project-scoped code graph, embeddings, search, and ticket sync. */
export class IndexingApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    async buildCodeGraph(input: {
        path?: string;
        includeTests?: boolean;
        extensions?: string[];
        useGitignore?: boolean;
        persist?: boolean;
    }) {
        const projectPath = input.path || this.projectPath;
        const detector = new EntryPointDetector(projectPath);
        const entryPoints = await detector.detectEntryPoints();
        const graph = new CodeGraph(projectPath, {
            includeTests: input.includeTests ?? true,
            extensions: input.extensions,
            useGitignore: input.useGitignore ?? true,
            maxDepth: 15,
        });
        await graph.scanProject();
        const stats = graph.getStats();
        const allFiles = graph.getAllFiles();
        const totalSize = allFiles.reduce((sum, node) => sum + node.size, 0);
        const totalLines = allFiles.reduce((sum, node) => sum + node.lines, 0);

        let skippedFiles: Array<{ path: string; reason: string }> = [];
        if (input.persist ?? true) {
            const db = new CodeGraphDB(projectPath);
            try {
                const nodes = new Map<string, (typeof allFiles)[number]>();
                for (const node of allFiles) {
                    nodes.set(node.filePath, node);
                }
                const dbEntryPoints = entryPoints.map((ep) => ({
                    file: ep.file,
                    framework: ep.framework,
                    role: ep.role || "main",
                    type: ep.type,
                }));
                skippedFiles = db.saveGraph(nodes, dbEntryPoints).skippedFiles;
            } finally {
                db.close();
            }
        }

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
            skippedFiles,
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
    }

    getGraphStats(input: { path?: string } = {}) {
        const projectPath = input.path || this.projectPath;
        const db = new CodeGraphDB(projectPath);
        const stats = db.getStats();
        db.close();
        if (!stats) return null;
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
    }

    getFileChangeBump() {
        const projectCtx = ProjectContext.getInstance(this.projectPath);
        return { bump: projectCtx.getFileChangeBump() };
    }

    getGraphFiles(input: { path?: string; limit?: number; offset?: number } = {}) {
        const projectPath = input.path || this.projectPath;
        const limit = input.limit ?? 1000;
        const offset = input.offset ?? 0;
        const db = new CodeGraphDB(projectPath);
        const rawFiles = db.getFiles();
        db.close();
        const allFiles = rawFiles.filter(
            (file) => !/\.raiken-run-\d+\.spec\.(ts|tsx|js|jsx)$/.test(file.relative_path),
        );
        const paginated = allFiles.slice(offset, offset + limit);
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
            hasMore: offset + limit < allFiles.length,
        };
    }

    getFileDependencies(input: { path?: string; filePath: string }) {
        const projectPath = input.path || this.projectPath;
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
    }

    async getFileContent(input: { filePath: string }) {
        const fullPath = assertUnderProjectRoot(
            path.join(this.projectPath, input.filePath),
            this.projectPath,
        );
        try {
            const content = await fs.readFile(fullPath, "utf-8");
            return {
                filePath: input.filePath,
                content,
                timestamp: new Date().toISOString(),
            };
        } catch {
            throw notFoundError(`Failed to read file: ${input.filePath}`, {
                code: "FILE_NOT_FOUND",
                details: { filePath: input.filePath },
            });
        }
    }

    async generateEmbeddings(input: { path?: string; forceRegenerate?: boolean } = {}) {
        const projectPath = input.path || this.projectPath;
        const db = new CodeGraphDB(projectPath);
        const embGen = EmbeddingsGenerator.getInstance();
        let totalChunks = 0;
        let filesProcessed = 0;
        let totalFiles = 0;
        const skipped: Array<{ path: string; reason: string }> = [];

        try {
            await embGen.initialize();
            const files = db.getFiles();
            totalFiles = files.length;

            for (const file of files) {
                try {
                    if (!input.forceRegenerate && db.hasEmbeddings(file.id)) continue;
                    if (!file.ast) {
                        skipped.push({ path: file.relative_path, reason: "no AST data" });
                        continue;
                    }
                    let ast: unknown;
                    try {
                        ast = JSON.parse(file.ast);
                    } catch {
                        skipped.push({
                            path: file.relative_path,
                            reason: "failed to parse stored AST",
                        });
                        continue;
                    }
                    const searchableText = fullAstToSearchableText(ast, file.relative_path);
                    if (!searchableText || searchableText.trim().length === 0) continue;
                    const chunks = [
                        { type: "file" as const, name: file.relative_path, text: searchableText },
                    ];
                    const texts = chunks.map((c) => c.text);
                    const embeddings = await embGen.generateEmbeddingsBatch(texts);
                    const chunksWithEmbeddings = chunks
                        .map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }))
                        .filter(
                            (chunk): chunk is typeof chunk & { embedding: number[] } =>
                                chunk.embedding !== null && chunk.embedding !== undefined,
                        );
                    if (chunksWithEmbeddings.length === 0) {
                        skipped.push({
                            path: file.relative_path,
                            reason: "embedding generation failed",
                        });
                        continue;
                    }
                    db.saveEmbeddings(file.id, chunksWithEmbeddings);
                    totalChunks += chunksWithEmbeddings.length;
                    filesProcessed++;
                } catch (fileError) {
                    const reason =
                        fileError instanceof Error ? fileError.message : String(fileError);
                    skipped.push({ path: file.relative_path, reason });
                }
            }

            return {
                success: true,
                filesProcessed,
                totalFiles,
                chunksGenerated: totalChunks,
                skipped,
                modelUsed: "Xenova/all-MiniLM-L6-v2",
                embeddingDimension: 384,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                filesProcessed,
                totalFiles,
                chunksGenerated: totalChunks,
                skipped,
                timestamp: new Date().toISOString(),
            };
        } finally {
            db.close();
        }
    }

    async searchCode(input: {
        path?: string;
        query: string;
        limit?: number;
        chunkTypes?: Array<"function" | "class" | "file" | "type">;
    }) {
        const projectPath = input.path || this.projectPath;
        const db = new CodeGraphDB(projectPath);
        const embGen = EmbeddingsGenerator.getInstance();
        try {
            const embeddingsCount = db.getEmbeddingsCount();
            if (embeddingsCount === 0) {
                db.close();
                return {
                    query: input.query,
                    results: [],
                    message:
                        "No search index yet. Run `raiken index --embeddings` to build one, then try your search again.",
                    timestamp: new Date().toISOString(),
                };
            }
            await embGen.initialize();
            const queryEmbedding = await embGen.generateEmbedding(input.query);
            const results = db.searchSimilar(queryEmbedding, input.limit ?? 10, input.chunkTypes);
            db.close();
            const relevant = results.flatMap((r) => {
                const relevance = toRelevanceResult(r);
                return relevance ? [{ ...r, ...relevance }] : [];
            });
            return {
                query: input.query,
                results: relevant.map((r) => ({
                    filePath: r.filePath,
                    chunkType: r.chunkType,
                    chunkName: r.chunkName,
                    chunkText: r.chunkText,
                    similarity: r.similarity,
                    relevanceScore: r.relevanceScore,
                })),
                totalResults: relevant.length,
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
    }

    getEmbeddingsStats(input: { path?: string } = {}) {
        const projectPath = input.path || this.projectPath;
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
    }

    getAffectedTests(input: { changedFiles: string[]; path?: string }) {
        const projectPath = input.path || this.projectPath;
        const db = new CodeGraphDB(projectPath);
        const results = db.getAffectedTests(input.changedFiles);
        db.close();
        return { affected: results, timestamp: new Date().toISOString() };
    }

    async reindexFiles(input: { files: string[]; path?: string }) {
        const projectPath = input.path || this.projectPath;
        const ctx = ProjectContext.getInstance(projectPath);
        if (!ctx.isInitialized()) {
            await ctx.initialize();
        }
        await ctx.refresh(input.files);
        return {
            success: true,
            filesRefreshed: input.files.length,
            timestamp: new Date().toISOString(),
        };
    }

    async syncTicket(input: { ticketId?: string; path?: string }) {
        const projectPath = input.path || this.projectPath;
        const integrationConfig = loadIntegrationsConfig(projectPath);
        const resolved = resolveAIConfig(projectPath);
        return syncCurrentTicket({
            projectPath,
            config: integrationConfig as Parameters<typeof syncCurrentTicket>[0]["config"],
            ticketId: input.ticketId,
            ai: resolved,
        });
    }

    getTicketStatus(input: { path?: string } = {}) {
        const projectPath = input.path || this.projectPath;
        const branch = getCurrentBranch(projectPath);
        if (!branch) {
            return { branch: null, ticket: null };
        }
        const integrationConfig = loadIntegrationsConfig(projectPath);
        const parsed = parseTicketFromBranch(
            branch,
            integrationConfig as Parameters<typeof parseTicketFromBranch>[1],
        );
        return {
            branch,
            ticket: parsed ? { id: parsed.ticketId, provider: parsed.provider } : null,
        };
    }
}
