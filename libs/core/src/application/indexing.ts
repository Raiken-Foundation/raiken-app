import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAIConfig } from "../agent/ai-providers";
import { fullAstToSearchableText } from "../analysis/ast-parser";
import { CodeGraph } from "../analysis/code-graph";
import { EntryPointDetector } from "../analysis/entry-points";
import { ProjectContext } from "../analysis/project-context";
import { loadIntegrationsConfig } from "../config";
import { CodeGraphDB } from "../database/db";
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
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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

    async searchCode(input: { path?: string; query: string; limit?: number }) {
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
        try {
            // Keyword search over the code-graph index — the replacement for
            // the removed embeddings/vector store. No model download, no
            // separate build step: the keyword index exists as soon as the
            // code graph does.
            const ctx = ProjectContext.getInstance(projectPath);
            if (!ctx.isInitialized()) {
                await ctx.initialize();
            }
            const limit = input.limit ?? 10;
            const filePaths = ctx.findRelevantFiles(input.query, limit);

            const db = new CodeGraphDB(projectPath);
            let rows: Array<{
                filePath: string;
                chunkType: string;
                chunkName: string;
                chunkText: string;
                similarity: number;
                relevanceScore: number;
            }> = [];
            try {
                for (const filePath of filePaths) {
                    const file = db.getFileByRelativePath(filePath);
                    if (!file) continue;
                    const rank = filePaths.indexOf(filePath);
                    const score = 1 - rank / Math.max(filePaths.length * 2, 1);
                    rows.push({
                        filePath,
                        chunkType: "file",
                        chunkName: file.relative_path,
                        chunkText: (file.ast ?? "").slice(0, 200),
                        similarity: score,
                        relevanceScore: Math.round(score * 100),
                    });
                }
            } finally {
                db.close();
            }
            return {
                query: input.query,
                results: rows,
                totalResults: rows.length,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            return {
                query: input.query,
                results: [],
                error: error instanceof Error ? error.message : "Unknown error",
                timestamp: new Date().toISOString(),
            };
        }
    }

    getAffectedTests(input: { changedFiles: string[]; path?: string }) {
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
        const db = new CodeGraphDB(projectPath);
        const results = db.getAffectedTests(input.changedFiles);
        db.close();
        return { affected: results, timestamp: new Date().toISOString() };
    }

    async reindexFiles(input: { files: string[]; path?: string }) {
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
        const files = input.files.map((file) => assertUnderProjectRoot(file, projectPath));
        const ctx = ProjectContext.getInstance(projectPath);
        if (!ctx.isInitialized()) {
            await ctx.initialize();
        }
        await ctx.refresh(files);
        return {
            success: true,
            filesRefreshed: input.files.length,
            timestamp: new Date().toISOString(),
        };
    }

    async syncTicket(input: { ticketId?: string; path?: string }) {
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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
        const projectPath = assertUnderProjectRoot(input.path || ".", this.projectPath);
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
