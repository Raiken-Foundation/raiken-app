// libs/api/src/lib/router.ts
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import * as path from "path";
import { CodeGraph, EntryPointDetector, formatBytes, CodeGraphDB } from "@raiken/core";

const t = initTRPC.create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return { status: "ok", engine: "raiken-lib" };
    }),

    getProjectInfo: t.procedure.query(() => {
        return {
            cwd: process.cwd(),
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
            })
        )
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();

            // Detect entry points
            const detector = new EntryPointDetector(projectPath);
            const entryPoints = await detector.detectEntryPoints();

            // Build code graph
            const graph = new CodeGraph(projectPath, {
                includeTests: input.includeTests,
                extensions: input.extensions,
                useGitignore: input.useGitignore,
                maxDepth: 15
            });

            // Use entry points if available, otherwise scan entire project
            if (entryPoints.length > 0) {
                await graph.initialize(entryPoints.map(ep => ep.file));
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
                const dbEntryPoints = entryPoints.map(ep => ({
                    file: ep.file,
                    framework: ep.framework,
                    role: ep.role || 'main',
                    type: ep.type
                }));
                db.saveGraph(nodes, dbEntryPoints);
                db.close();
            }

            // Return graph structure with linkages
            return {
                projectRoot: projectPath,
                entryPoints: entryPoints.map(ep => ({
                    file: path.relative(projectPath, ep.file),
                    framework: ep.framework,
                    role: ep.role,
                    type: ep.type
                })),
                stats,
                totalSize,
                totalLines,
                totalSizeFormatted: formatBytes(totalSize),
                files: allFiles.map(node => ({
                    path: node.relativePath,
                    depth: node.depth,
                    functions: node.parsed.functions.length,
                    classes: node.parsed.classes.length,
                    types: node.parsed.types.length,
                    size: node.size,
                    lines: node.lines,
                    imports: node.imports.map(imp => path.relative(projectPath, imp)),
                    importedBy: node.importedBy.map(imp => path.relative(projectPath, imp))
                }))
            };
        }),

    getGraphStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
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
        .input(z.object({
            path: z.string().optional(),
            limit: z.number().default(100),
            offset: z.number().default(0),
        }))
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const allFiles = db.getFiles();
            db.close();

            const paginated = allFiles.slice(input.offset, input.offset + input.limit);

            return {
                total: allFiles.length,
                files: paginated.map(file => ({
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
        .input(z.object({
            path: z.string().optional(),
            filePath: z.string(),
        }))
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            
            const dependencies = db.getDependencies(path.join(projectPath, input.filePath));
            const dependents = db.getDependents(path.join(projectPath, input.filePath));
            
            db.close();

            return {
                filePath: input.filePath,
                imports: dependencies.map(dep => path.relative(projectPath, dep.target_file)),
                importedBy: dependents.map(dep => path.relative(projectPath, dep.source_file)),
            };
        }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
