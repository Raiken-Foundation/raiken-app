import fs from "node:fs";
import path from "node:path";
import {
    AgentMemory,
    CodeGraph,
    CodeGraphDB,
    EntryPointDetector,
    getCurrentBranch,
    ProjectContext,
    parseTicketFromBranch,
} from "@raiken/core";

export interface BootstrapOptions {
    /** Start the live file watcher for incremental indexing. Default true. */
    watch?: boolean;
    /** Emit progress logs. Default true. */
    verbose?: boolean;
}

/**
 * Bootstrap a project so the agent has everything it needs: a code graph in
 * SQLite, an initialized ProjectContext (semantic search + module map), and
 * AgentMemory (learned selectors/preferences). Shared by `raiken start` (the
 * dashboard server) and `raiken chat` (the interactive CLI) so both surfaces
 * behave identically — the agent doesn't care which one invoked it.
 *
 * Safe to call on a project that's never been scanned: it builds the graph on
 * first run, and reuses the cached graph on subsequent runs.
 */
export async function bootstrapProject(
    projectPath: string,
    options: BootstrapOptions = {},
): Promise<void> {
    const { watch = true, verbose = true } = options;
    const log = (...args: unknown[]) => {
        if (verbose) console.log(...args);
    };

    try {
        log("Initializing project context...");
        let fullScan = false;
        try {
            const configPath = path.join(projectPath, "raiken.config.json");
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            fullScan = Boolean(config?.indexing?.fullScan);
        } catch {
            // Config not found or invalid
        }

        // Ensure the DB has a graph if it's empty (or a full scan is forced).
        const db = new CodeGraphDB(projectPath);
        const files = db.getFiles();

        if (files.length === 0 || fullScan) {
            const graph = new CodeGraph(projectPath, {
                includeTests: false,
                useGitignore: true,
                maxDepth: 15,
            });

            const detector = new EntryPointDetector(projectPath);
            const entryPoints = await detector.detectEntryPoints();

            if (!fullScan && entryPoints.length > 0) {
                log(`Found ${entryPoints.length} entry points`);
                await graph.initialize(entryPoints.map((ep) => ep.file));
            } else {
                log(fullScan ? "Full scan forced by config..." : "Scanning entire project...");
                await graph.scanProject();
            }

            const allFiles = graph.getAllFiles();
            const nodes = new Map();
            for (const node of allFiles) {
                nodes.set(node.filePath, node);
            }

            const dbEntryPoints = entryPoints.map((ep) => ({
                file: ep.file,
                framework: ep.framework,
                role: ep.role || "main",
                type: ep.type,
            }));

            db.saveGraph(nodes, dbEntryPoints);
            log(`Code graph built: ${allFiles.length} files indexed`);
            graph.destroy();
        } else {
            log(`Code graph exists: ${files.length} files indexed`);
        }

        db.close();

        const projectContext = ProjectContext.getInstance(projectPath);
        await projectContext.initialize(verbose);

        if (watch) {
            projectContext.startWatching();
            log("File watcher active (incremental indexing enabled)");
        }

        const modules = projectContext.getModules();
        if (modules.length > 0) {
            log(
                `Modules: ${modules
                    .slice(0, 5)
                    .map((m) => m.name)
                    .join(", ")}`,
            );
        }
        log(`Keywords: ${projectContext.getKeywordCount()}`);
        log(`Files: ${projectContext.getFileCount()}`);

        const agentMemory = AgentMemory.getInstance(projectPath);
        agentMemory.initialize(verbose);
        const prefCount = Object.keys(agentMemory.getAllPreferences()).length;
        if (prefCount > 0) log(`Memory: ${prefCount} preferences loaded`);

        // Auto-detect ticket from current branch (non-blocking, informational).
        const branch = getCurrentBranch(projectPath);
        if (branch) {
            let integrationConfig: Record<string, unknown> | undefined;
            try {
                const cfgPath = path.join(projectPath, "raiken.config.json");
                integrationConfig = JSON.parse(fs.readFileSync(cfgPath, "utf-8"))?.integrations;
            } catch {
                /* no config */
            }
            const parsed = parseTicketFromBranch(
                branch,
                integrationConfig as Parameters<typeof parseTicketFromBranch>[1],
            );
            if (parsed) {
                log(`Ticket detected: ${parsed.ticketId} (${parsed.provider}) from "${branch}"`);
            } else {
                log(`Branch: ${branch} (no ticket ID detected)`);
            }
        }
    } catch (error) {
        console.warn(
            "Failed to initialize project context:",
            error instanceof Error ? error.message : error,
        );
    }
}
