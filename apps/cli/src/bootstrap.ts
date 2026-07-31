import {
    AgentMemory,
    CodeGraph,
    CodeGraphDB,
    EntryPointDetector,
    getCurrentBranch,
    ProjectContext,
    parseTicketFromBranch,
} from "@raiken/core";
import { loadIndexingConfig, loadIntegrationsConfig } from "@raiken/shared/server";

export interface BootstrapOptions {
    /** Start the live file watcher for incremental indexing. Default true. */
    watch?: boolean;
    /** Emit progress logs. Default true. */
    verbose?: boolean;
}

export interface BootstrapResult {
    /**
     * False only for failures that leave the agent with NO code
     * understanding at all (DB unopenable, or a first-time graph build
     * failing with no prior index to fall back on). Callers that need code
     * understanding to function (e.g. `raiken index`) should treat this as
     * fatal; callers that can still do useful work in a degraded state
     * (dashboard server, chat REPL) should warn loudly and continue.
     */
    ok: boolean;
    /** Non-fatal issues encountered along the way (parse failures skipped,
     * context/memory degraded, etc). Always safe to ignore, but worth
     * surfacing to the user instead of leaving them silently in the dark. */
    warnings: string[];
    filesIndexed: number;
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
 *
 * Never throws — every step that can fail is isolated so one broken part
 * (a corrupt DB, a failed embedding model load, a single unparseable file)
 * degrades that capability instead of taking down the whole bootstrap. The
 * returned `ok`/`warnings` tell the caller how degraded things are so it can
 * decide whether to keep going, warn, or exit.
 */
export async function bootstrapProject(
    projectPath: string,
    options: BootstrapOptions = {},
): Promise<BootstrapResult> {
    const { watch = true, verbose = true } = options;
    const warnings: string[] = [];
    // Diagnostics belong on stderr, always — callers shouldn't need to wrap
    // this in routeDiagnosticsToStderr() to keep stdout machine-clean, and
    // interactive surfaces show the same text either way.
    const log = (...args: unknown[]) => {
        if (!verbose) return;
        process.stderr.write(
            `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`,
        );
    };
    const warn = (message: string) => {
        warnings.push(message);
        console.warn(`[bootstrap] ${message}`);
    };

    log("Initializing project context...");
    const fullScan = loadIndexingConfig(projectPath).fullScan;

    // Opening the DB is the one failure that makes everything downstream
    // pointless (graph, embeddings, memory all live in it) — this is the
    // only step allowed to make bootstrap report `ok: false`.
    let db: CodeGraphDB;
    try {
        db = new CodeGraphDB(projectPath);
    } catch (error) {
        const message = `Could not open the code graph database (${
            error instanceof Error ? error.message : String(error)
        }). The agent will run with NO code understanding — search, impact analysis, and context lookup will be empty until this is fixed.`;
        console.error(`\n  ✗ ${message}\n`);
        return { ok: false, warnings: [message], filesIndexed: 0 };
    }

    let filesIndexed = 0;
    let hadExistingIndex = false;
    try {
        let files: ReturnType<CodeGraphDB["getFiles"]>;
        try {
            files = db.getFiles();
            hadExistingIndex = files.length > 0;
        } catch (error) {
            // Can't even read the existing index — treat like "no index" and
            // try a fresh build below rather than giving up immediately.
            warn(
                `Could not read the existing code graph (${
                    error instanceof Error ? error.message : String(error)
                }); rebuilding from scratch.`,
            );
            files = [];
        }

        if (files.length === 0 || fullScan) {
            try {
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

                const { skippedFiles } = db.saveGraph(nodes, dbEntryPoints);
                filesIndexed = allFiles.length - skippedFiles.length;
                log(`Code graph built: ${filesIndexed} files indexed`);
                if (skippedFiles.length > 0) {
                    warn(
                        `${skippedFiles.length} file(s) could not be added to the code graph and were skipped (e.g. ${skippedFiles[0]?.path}).`,
                    );
                }
                graph.destroy();
            } catch (error) {
                const message = `Failed to build the code graph (${
                    error instanceof Error ? error.message : String(error)
                }).`;
                if (!hadExistingIndex) {
                    // No prior index to fall back on — this is the fresh-project
                    // equivalent of "code understanding never worked at all".
                    // (The `finally` below still closes `db` on this path.)
                    console.error(`\n  ✗ ${message} No previous index to fall back on.\n`);
                    return { ok: false, warnings: [...warnings, message], filesIndexed: 0 };
                }
                warn(
                    `${message} Falling back to the previously indexed graph (${files.length} files).`,
                );
                filesIndexed = files.length;
            }
        } else {
            filesIndexed = files.length;
            log(`Code graph exists: ${files.length} files indexed`);
        }
    } catch (error) {
        // Belt-and-suspenders: nothing above should reach here, but bootstrap
        // must never throw regardless of what changes upstream.
        warn(
            `Unexpected error while preparing the code graph (${
                error instanceof Error ? error.message : String(error)
            }).`,
        );
    } finally {
        db.close();
    }

    try {
        const projectContext = ProjectContext.getInstance(projectPath);
        // Bootstrap narrates its own consolidated lines (above/below); the
        // engine's internal step logs ("Initializing ProjectContext...") are
        // debug noise that leaked into user output before.
        await projectContext.initialize(false);

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
    } catch (error) {
        warn(
            `Project context initialization failed (${
                error instanceof Error ? error.message : String(error)
            }). Semantic search and context lookups may return incomplete results${watch ? ", and the file watcher may not be active" : ""}.`,
        );
    }

    try {
        const agentMemory = AgentMemory.getInstance(projectPath);
        agentMemory.initialize(false);
        const prefCount = Object.keys(agentMemory.getAllPreferences()).length;
        if (prefCount > 0) log(`Memory: ${prefCount} preferences loaded`);
    } catch (error) {
        warn(
            `Agent memory failed to initialize (${
                error instanceof Error ? error.message : String(error)
            }). Learned selectors and past-failure context will be unavailable this session.`,
        );
    }

    // Auto-detect ticket from current branch (non-blocking, informational).
    try {
        const branch = getCurrentBranch(projectPath);
        if (branch) {
            const integrationConfig = loadIntegrationsConfig(projectPath);
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
    } catch {
        // Purely informational — never worth degrading bootstrap over.
    }

    return { ok: true, warnings, filesIndexed };
}
