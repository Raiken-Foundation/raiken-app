// libs/shared/src/lib/router.ts
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { loadDiscoveryConfig } from "./config";
import {
    EntryPointDetector,
    CodeGraph,
    CodeGraphDB,
    SiteKnowledgeDB,
    formatBytes,
    EmbeddingsGenerator,
    fullAstToSearchableText,
    writePlaywrightConfig,
    playwrightConfigExists,
    getQuickInterpretation,
    SiteDiscovery,
    DiscoveryQueryService,
} from "@raiken/core";

async function findPlaywrightConfigPath(projectPath: string): Promise<string | null> {
    const candidates = [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mts",
        "playwright.config.mjs",
        "playwright.config.cjs",
    ];

    for (const name of candidates) {
        const fullPath = path.join(projectPath, name);
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {
            // continue
        }
    }

    return null;
}

// Context type for tRPC procedures
export interface Context {
  projectPath: string;
}

// In-memory message store (persists until server stops)
interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'assistant';
  timestamp: number;
  fileMentions?: string[];
}

// Store messages per project path
const messageStore: Map<string, ChatMessage[]> = new Map();

function getMessages(projectPath: string): ChatMessage[] {
  return messageStore.get(projectPath) || [];
}

function addMessage(projectPath: string, message: ChatMessage): void {
  const messages = getMessages(projectPath);
  messages.push(message);
  messageStore.set(projectPath, messages);
}

function clearMessages(projectPath: string): void {
  messageStore.set(projectPath, []);
}

type DiscoveryPhase = "idle" | "running" | "paused" | "completed" | "error";

interface DiscoveryRuntimeEvent {
    id: string;
    timestamp: string;
    type: "page_discovered" | "auth_blocked" | "session_completed" | "error" | "started" | "continued" | "cleared";
    message: string;
    data?: Record<string, unknown>;
}

interface DiscoveryRuntimeState {
    phase: DiscoveryPhase;
    startedAt: string | null;
    updatedAt: string;
    currentUrl: string | null;
    currentDepth: number;
    pagesDiscovered: number;
    linksFound: number;
    authBlockersFound: number;
    blockedAtUrl: string | null;
    requiresAuth: boolean;
    lastError: string | null;
    lastEvents: DiscoveryRuntimeEvent[];
    maxPages: number | null;
    maxDepth: number | null;
    completionReason: string | null;
}

interface DiscoveryJob {
    discovery: SiteDiscovery;
    promise: Promise<void>;
}

const discoveryRuntimeStore: Map<string, DiscoveryRuntimeState> = new Map();
const discoveryJobStore: Map<string, DiscoveryJob> = new Map();
const MAX_DISCOVERY_EVENTS = 100;

function createEmptyDiscoveryState(): DiscoveryRuntimeState {
    return {
        phase: "idle",
        startedAt: null,
        updatedAt: new Date().toISOString(),
        currentUrl: null,
        currentDepth: 0,
        pagesDiscovered: 0,
        linksFound: 0,
        authBlockersFound: 0,
        blockedAtUrl: null,
        requiresAuth: false,
        lastError: null,
        lastEvents: [],
        maxPages: null,
        maxDepth: null,
        completionReason: null,
    };
}

function getDiscoveryState(projectPath: string): DiscoveryRuntimeState {
    const existing = discoveryRuntimeStore.get(projectPath);
    if (existing) {
        return existing;
    }
    const created = createEmptyDiscoveryState();
    discoveryRuntimeStore.set(projectPath, created);
    return created;
}

function patchDiscoveryState(
    projectPath: string,
    patch: Partial<DiscoveryRuntimeState>
): DiscoveryRuntimeState {
    const current = getDiscoveryState(projectPath);
    const next: DiscoveryRuntimeState = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    discoveryRuntimeStore.set(projectPath, next);
    return next;
}

function pushDiscoveryEvent(
    projectPath: string,
    event: Omit<DiscoveryRuntimeEvent, "id" | "timestamp">
): void {
    const state = getDiscoveryState(projectPath);
    const nextEvent: DiscoveryRuntimeEvent = {
        ...event,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
    };
    const events = [...state.lastEvents, nextEvent].slice(-MAX_DISCOVERY_EVENTS);
    patchDiscoveryState(projectPath, { lastEvents: events });
}

// Discovery config is loaded via loadDiscoveryConfig from ./config

function toDiscoveryPhase(status: string | undefined): DiscoveryPhase {
    if (status === "running" || status === "paused" || status === "completed") {
        return status;
    }
    if (status === "failed") {
        return "error";
    }
    return "idle";
}

async function hydrateDiscoveryState(projectPath: string): Promise<DiscoveryRuntimeState> {
    const current = getDiscoveryState(projectPath);
    const queryService = new DiscoveryQueryService(projectPath);

    try {
        // On first hydration, recover sessions stuck as "running" from a previous crash.
        // Only do this when there is no in-process job (i.e. the server restarted).
        if (!discoveryJobStore.has(projectPath) && current.phase !== "running") {
            const recovered = queryService.recoverStaleSessions();
            if (recovered > 0) {
                console.log(`⚠️  Recovered ${recovered} stale discovery session(s) for ${projectPath}`);
            }
        }

        const stats = queryService.getStats();
        const session = queryService.getLatestSession();

        const next = patchDiscoveryState(projectPath, {
            phase:
                current.phase === "running"
                    ? "running"
                    : toDiscoveryPhase(session?.status),
            startedAt:
                typeof session?.startedAt === "number"
                    ? new Date(session.startedAt).toISOString()
                    : current.startedAt,
            pagesDiscovered: stats.pagesCount,
            linksFound: stats.linksCount,
            authBlockersFound: stats.unresolvedBlockersCount,
            blockedAtUrl: session?.blockedAtUrl ?? null,
            requiresAuth: session?.status === "paused" && Boolean(session.blockedAtUrl),
            currentUrl: current.currentUrl ?? session?.blockedAtUrl ?? null,
            lastError: current.lastError,
        });
        return next;
    } catch {
        return current;
    } finally {
        queryService.close();
    }
}

function toIsoDate(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) {
            return new Date(asNumber).toISOString();
        }
        const asDate = new Date(value);
        if (!Number.isNaN(asDate.getTime())) {
            return asDate.toISOString();
        }
    }
    return null;
}

function attachDiscoveryRuntimeListeners(projectPath: string, discovery: SiteDiscovery): void {
    discovery.on("page_discovered", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                page?: {
                    url?: string;
                    depth?: number;
                };
            };
        };
        const page = payload.data?.page;
        const state = getDiscoveryState(projectPath);
        patchDiscoveryState(projectPath, {
            phase: "running",
            currentUrl: page?.url ?? state.currentUrl,
            currentDepth: typeof page?.depth === "number" ? page.depth : state.currentDepth,
            pagesDiscovered: state.pagesDiscovered + 1,
            requiresAuth: false,
        });
        pushDiscoveryEvent(projectPath, {
            type: "page_discovered",
            message: page?.url ? `Discovered ${page.url}` : "Discovered a page",
            data: {
                url: page?.url ?? null,
                depth: page?.depth ?? null,
            },
        });
    });

    discovery.on("auth_blocked", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                blocker?: {
                    url?: string;
                    blockerType?: string;
                };
            };
        };
        const blocker = payload.data?.blocker;
        const state = getDiscoveryState(projectPath);
        patchDiscoveryState(projectPath, {
            phase: "paused",
            blockedAtUrl: blocker?.url ?? state.currentUrl,
            requiresAuth: true,
            authBlockersFound: state.authBlockersFound + 1,
            currentUrl: blocker?.url ?? state.currentUrl,
        });
        pushDiscoveryEvent(projectPath, {
            type: "auth_blocked",
            message: blocker?.url
                ? `Authentication required at ${blocker.url}`
                : "Authentication required",
            data: {
                url: blocker?.url ?? null,
                blockerType: blocker?.blockerType ?? null,
            },
        });
    });

    discovery.on("session_paused", () => {
        const state = getDiscoveryState(projectPath);
        patchDiscoveryState(projectPath, {
            phase: "paused",
            requiresAuth: true,
            blockedAtUrl: state.currentUrl ?? state.blockedAtUrl,
        });
    });

    discovery.on("session_resumed", () => {
        patchDiscoveryState(projectPath, {
            phase: "running",
            requiresAuth: false,
            lastError: null,
        });
        pushDiscoveryEvent(projectPath, {
            type: "continued",
            message: "Discovery resumed",
        });
    });

    discovery.on("session_completed", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                stats?: {
                    pagesDiscovered?: number;
                    linksFound?: number;
                    currentUrl?: string | null;
                    currentDepth?: number;
                };
            };
        };
        const stats = payload.data?.stats;
        const prevState = getDiscoveryState(projectPath);
        const finalPages = typeof stats?.pagesDiscovered === "number"
            ? stats.pagesDiscovered
            : prevState.pagesDiscovered;

        let completionReason: string | null = null;
        if (prevState.maxPages && finalPages >= prevState.maxPages) {
            completionReason = `Reached page limit (${prevState.maxPages})`;
        } else if (prevState.maxDepth && typeof stats?.currentDepth === "number" && stats.currentDepth >= prevState.maxDepth) {
            completionReason = `Reached depth limit (${prevState.maxDepth})`;
        } else {
            completionReason = "All reachable pages crawled";
        }

        patchDiscoveryState(projectPath, {
            phase: "completed",
            currentUrl: stats?.currentUrl ?? null,
            currentDepth:
                typeof stats?.currentDepth === "number" ? stats.currentDepth : 0,
            pagesDiscovered: finalPages,
            linksFound:
                typeof stats?.linksFound === "number"
                    ? stats.linksFound
                    : prevState.linksFound,
            requiresAuth: false,
            blockedAtUrl: null,
            completionReason,
        });
        pushDiscoveryEvent(projectPath, {
            type: "session_completed",
            message: `Discovery completed: ${completionReason}`,
        });
    });

    discovery.on("error", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                error?: Error;
            };
        };
        const message = payload.data?.error?.message ?? "Discovery failed";
        patchDiscoveryState(projectPath, {
            phase: "error",
            lastError: message,
            requiresAuth: false,
        });
        pushDiscoveryEvent(projectPath, {
            type: "error",
            message,
        });
    });
}

function startDiscoveryJob(options: {
    projectPath: string;
    startUrl: string;
    maxPages?: number;
    maxDepth?: number;
    timeout?: number;
    skipAuth?: boolean;
    excludePatterns?: string[];
    continueSession?: boolean;
}): void {
    if (discoveryJobStore.has(options.projectPath)) {
        throw new Error("Discovery is already running for this project");
    }

    const config = loadDiscoveryConfig(options.projectPath);
    const discovery = new SiteDiscovery({
        projectPath: options.projectPath,
        startUrl: options.startUrl,
        maxPages: options.maxPages ?? config.maxPages,
        maxDepth: options.maxDepth ?? config.maxDepth,
        maxConcurrency: config.maxConcurrency,
        timeout: options.timeout ?? config.timeout,
        excludePatterns: options.excludePatterns?.length
            ? options.excludePatterns
            : config.excludePatterns,
        pauseOnAuth: options.skipAuth ? false : config.pauseOnAuth,
        continueSession: options.continueSession ?? false,
    });

    attachDiscoveryRuntimeListeners(options.projectPath, discovery);

    const resolvedMaxPages = options.maxPages ?? config.maxPages;
    const resolvedMaxDepth = options.maxDepth ?? config.maxDepth;
    const now = new Date().toISOString();
    patchDiscoveryState(options.projectPath, {
        phase: "running",
        startedAt: now,
        updatedAt: now,
        currentUrl: options.startUrl,
        currentDepth: 0,
        lastError: null,
        requiresAuth: false,
        blockedAtUrl: null,
        maxPages: resolvedMaxPages ?? null,
        maxDepth: resolvedMaxDepth ?? null,
        completionReason: null,
    });
    pushDiscoveryEvent(options.projectPath, {
        type: options.continueSession ? "continued" : "started",
        message: options.continueSession
            ? `Resumed discovery at ${options.startUrl}`
            : `Started discovery at ${options.startUrl}`,
    });

    const promise = (async () => {
        try {
            await discovery.start();
            await hydrateDiscoveryState(options.projectPath);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Discovery failed unexpectedly";
            patchDiscoveryState(options.projectPath, {
                phase: "error",
                lastError: message,
                requiresAuth: false,
            });
            pushDiscoveryEvent(options.projectPath, {
                type: "error",
                message,
            });
        } finally {
            try {
                await discovery.close();
            } finally {
                discoveryJobStore.delete(options.projectPath);
            }
        }
    })();

    discoveryJobStore.set(options.projectPath, {
        discovery,
        promise,
    });
}

function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        const tgtVal = target[key];
        if (
            srcVal !== null &&
            typeof srcVal === "object" &&
            !Array.isArray(srcVal) &&
            tgtVal !== null &&
            typeof tgtVal === "object" &&
            !Array.isArray(tgtVal)
        ) {
            result[key] = deepMerge(
                tgtVal as Record<string, unknown>,
                srcVal as Record<string, unknown>,
            );
        } else {
            result[key] = srcVal;
        }
    }
    return result;
}

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return { 
            status: "ok", 
            engine: "raiken",
            version: "0.3.0"
        };
    }),

    getProjectInfo: t.procedure.query(async ({ ctx }) => {
        return {
            path: ctx.projectPath,
            nodeVersion: process.version,
        };
    }),

    getConfig: t.procedure.query(async ({ ctx }) => {
        const configPath = path.join(ctx.projectPath, "raiken.config.json");
        try {
            const raw = await fs.readFile(configPath, "utf-8");
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {} as Record<string, unknown>;
        }
    }),

    updateConfig: t.procedure
        .input(
            z.object({
                config: z.record(z.string(), z.unknown()),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const configPath = path.join(ctx.projectPath, "raiken.config.json");
            let existing: Record<string, unknown> = {};
            try {
                const raw = await fs.readFile(configPath, "utf-8");
                existing = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                // file doesn't exist yet — start fresh
            }

            const merged = deepMerge(existing, input.config);
            await fs.writeFile(configPath, JSON.stringify(merged, null, 4), "utf-8");
            return { success: true };
        }),

    // Chat message persistence endpoints
    getChatMessages: t.procedure.query(({ ctx }) => {
        return { messages: getMessages(ctx.projectPath) };
    }),

    addChatMessage: t.procedure
        .input(
            z.object({
                id: z.string(),
                content: z.string(),
                sender: z.enum(['user', 'assistant']),
                timestamp: z.number(),
                fileMentions: z.array(z.string()).optional(),
            })
        )
        .mutation(({ input, ctx }) => {
            addMessage(ctx.projectPath, input);
            return { success: true, messageCount: getMessages(ctx.projectPath).length };
        }),

    clearChatMessages: t.procedure.mutation(({ ctx }) => {
        clearMessages(ctx.projectPath);
        return { success: true };
    }),

    buildCodeGraph: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                includeTests: z.boolean().default(true),
                extensions: z.array(z.string()).optional(),
                useGitignore: z.boolean().default(true),
                persist: z.boolean().default(true),
            })
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
                maxDepth: 15
            });

            // Scan entire project to index all non-binary files
            await graph.scanProject();

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
        .query(async ({ input }) => {
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
        .query(async ({ input }) => {
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
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            
            const dependencies = db.getDependencies(path.join(projectPath, input.filePath));
            const dependents = db.getDependents(path.join(projectPath, input.filePath));
            
            db.close();

            return {
                filePath: input.filePath,
                imports: dependencies.map(dep => path.relative(projectPath, dep.target_file)),
                importedBy: dependents.map(dep => path.relative(projectPath, dep.source_file)),
                timestamp: new Date().toISOString()
        };
        }),

    getFileContent: t.procedure
        .input(z.object({
            filePath: z.string(),
        }))
        .query(async ({ input }) => {
            const projectPath = process.cwd();
            const fullPath = path.join(projectPath, input.filePath);
            
            try {
                const fs = await import('node:fs/promises');
                const content = await fs.readFile(fullPath, 'utf-8');
                return {
                    filePath: input.filePath,
                    content,
                    timestamp: new Date().toISOString()
                };
            } catch {
                throw new Error(`Failed to read file: ${input.filePath}`);
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
            })
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
                    let ast: unknown;
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
                    const chunks = [{
                        type: 'file' as const,
                        name: file.relative_path,
                        text: searchableText,
                    }];

                    // Generate embeddings
                    const texts = chunks.map(c => c.text);
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
                    modelUsed: 'Xenova/all-MiniLM-L6-v2',
                    embeddingDimension: 384,
                    timestamp: new Date().toISOString(),
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
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
                chunkTypes: z.array(z.enum(['function', 'class', 'file', 'type'])).optional(),
            })
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
                        message: 'No embeddings found. Please run generateEmbeddings first.',
                        timestamp: new Date().toISOString(),
                    };
                }

                // Generate embedding for query
                await embGen.initialize();
                const queryEmbedding = await embGen.generateEmbedding(input.query);

                // Search database
                const results = db.searchSimilar(
                    queryEmbedding,
                    input.limit,
                    input.chunkTypes
                );

                db.close();

                return {
                    query: input.query,
                    results: results.map(r => ({
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
                    error: error instanceof Error ? error.message : 'Unknown error',
                    timestamp: new Date().toISOString(),
                };
            }
        }),

    getEmbeddingsStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            
            const totalEmbeddings = db.getEmbeddingsCount();
            const totalFiles = db.getStats()?.total_files || 0;
            
            db.close();

            return {
                totalEmbeddings,
                totalFiles,
                embeddingsPerFile: totalFiles > 0 ? (totalEmbeddings / totalFiles).toFixed(2) : '0',
                modelUsed: 'Xenova/all-MiniLM-L6-v2',
                embeddingDimension: 384,
                timestamp: new Date().toISOString(),
            };
        }),

    saveGeneratedTest: t.procedure
        .input(
            z.object({
                fileName: z.string(),
                content: z.string(),
                testDir: z.string().optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const { fileName, testDir: customTestDir } = input;
            let { content } = input;

            // Extract code from markdown fences if present
            const fenceMatch = content.match(/```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i);
            if (fenceMatch) {
                content = fenceMatch[1];
            } else {
                // Fallback: strip opening fence from start
                content = content.replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/i, '');
                // Strip closing fence and anything after it
                const closingIdx = content.lastIndexOf('\n```');
                if (closingIdx !== -1) {
                    content = content.substring(0, closingIdx);
                }
            }
            content = content.trim();

            // Load test directory from raiken.config.json if exists
            let testDirectory = customTestDir || 'e2e';
            const configPath = path.join(ctx.projectPath, 'raiken.config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                testDirectory = config.testDirectory || testDirectory;
            } catch {
                // Use default or provided testDir
            }

            // Validate filename
            if (!fileName.match(/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/)) {
                throw new Error('Invalid filename. Must be a test file (*.spec.ts, *.test.tsx, etc.)');
            }

            // Prevent directory traversal
            if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
                throw new Error('Filename must not contain path separators or parent directory references');
            }

            // Create test directory if it doesn't exist
            const testDirPath = path.join(ctx.projectPath, testDirectory);
            await fs.mkdir(testDirPath, { recursive: true });

            // Write the test file
            const filePath = path.join(testDirPath, fileName);
            await fs.writeFile(filePath, content, 'utf-8');

            console.log(`✓ Saved generated test: ${path.relative(ctx.projectPath, filePath)}`);

            return {
                success: true,
                filePath: path.relative(ctx.projectPath, filePath),
                absolutePath: filePath,
            };
        }),

    saveFileContent: t.procedure
        .input(
            z.object({
                filePath: z.string(),
                content: z.string(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const resolved = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(ctx.projectPath, input.filePath);

            // Prevent writes outside project
            if (!resolved.startsWith(ctx.projectPath)) {
                throw new Error('Cannot write files outside the project directory');
            }

            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, input.content, 'utf-8');
            console.log(`✓ Saved file: ${path.relative(ctx.projectPath, resolved)}`);

            return {
                success: true,
                filePath: path.relative(ctx.projectPath, resolved),
            };
        }),

    deleteTestFile: t.procedure
        .input(
            z.object({
                filePath: z.string(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const resolved = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(ctx.projectPath, input.filePath);

            if (!resolved.startsWith(ctx.projectPath)) {
                throw new Error('Cannot delete files outside the project directory');
            }

            try {
                await fs.access(resolved);
            } catch {
                throw new Error(`File not found: ${input.filePath}`);
            }

            await fs.unlink(resolved);
            console.log(`🗑️  Deleted file: ${path.relative(ctx.projectPath, resolved)}`);

            return {
                success: true,
                filePath: path.relative(ctx.projectPath, resolved),
            };
        }),

    // List test files from the filesystem (not from code graph)
    listTestFiles: t.procedure
        .input(
            z.object({
                testDir: z.string().optional(),
            })
        )
        .query(async ({ input, ctx }) => {
            // Load test directory from raiken.config.json if exists
            let testDirectory = input.testDir || 'e2e';
            const configPath = path.join(ctx.projectPath, 'raiken.config.json');
            
            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);
                testDirectory = config.testDirectory || testDirectory;
            } catch {
                // Use default or provided testDir
            }

            const testDirPath = path.join(ctx.projectPath, testDirectory);
            const testFiles: Array<{ name: string; path: string; directory: string }> = [];

            // Check if test directory exists
            try {
                await fs.access(testDirPath);
            } catch {
                // Directory doesn't exist, return empty array
                return { files: testFiles, testDirectory };
            }

            // Recursively scan for test files
            async function scanDir(dirPath: string, relativePath = '') {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        const entryPath = path.join(dirPath, entry.name);
                        const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                        
                        if (entry.isDirectory()) {
                            await scanDir(entryPath, entryRelPath);
                        } else if (entry.isFile()) {
                            // Check if it's a test file
                            if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                                testFiles.push({
                                    name: entry.name,
                                    path: `${testDirectory}/${entryRelPath}`,
                                    directory: testDirectory + (relativePath ? `/${relativePath}` : ''),
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error scanning directory ${dirPath}:`, error);
                }
            }

            await scanDir(testDirPath);

            return { files: testFiles, testDirectory };
        }),

    // Run Playwright tests with performance options
    runTests: t.procedure
        .input(
            z.object({
                testFile: z.string().optional(), // Specific file to run, or all if not provided
                testName: z.string().optional(), // Specific test name to run
                parallel: z.boolean().default(true), // Run tests in parallel
                workers: z.number().optional(), // Number of workers (auto if not specified)
            })
        )
        .mutation(async ({ input, ctx }) => {
            const { spawn } = await import('node:child_process');

            // Auto-create playwright.config.ts if one doesn't exist
            let configPath = await findPlaywrightConfigPath(ctx.projectPath);
            if (!configPath) {
                const result = await writePlaywrightConfig(ctx.projectPath, {
                    testDir: './e2e',
                });
                if (result.success) {
                    configPath = result.path;
                    console.log('🧪 Auto-created playwright.config.ts');
                }
            }
            
            return new Promise((resolve) => {
                const args = ['test'];
                
                // Add specific test file if provided
                if (input.testFile) {
                    args.push(input.testFile);
                }
                
                // Add test name filter if provided
                if (input.testName) {
                    args.push('-g', input.testName);
                }
                
                // Performance options - only add workers if explicitly set to a number
                // Omitting --workers flag lets Playwright auto-detect
                if (input.workers !== undefined && typeof input.workers === 'number') {
                    args.push(`--workers=${input.workers}`);
                }
                
                // Add reporter for structured output
                args.push('--reporter=json');

                if (configPath) {
                    args.push('--config', configPath);
                }
                
                console.log(`🧪 Running tests: npx playwright ${args.join(' ')}`);
                console.log(`🧪 Using config: ${configPath || 'default'}`);

                const testProcess = spawn('npx', ['playwright', ...args], {
                    cwd: ctx.projectPath,
                    shell: true,
                    env: { ...process.env, FORCE_COLOR: '0' },
                });
                
                    let stdout = '';
                    let stderr = '';
                
                    testProcess.stdout?.on('data', (data) => {
                        stdout += data.toString();
                    });
                
                    testProcess.stderr?.on('data', (data) => {
                        stderr += data.toString();
                    });
                
                    testProcess.on('close', (code) => {
                        console.log(`🧪 Tests completed with exit code: ${code}`);
                    
                        // Try to parse JSON output
                        let results = null;
                        try {
                            // Find the JSON part in the output
                            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                results = JSON.parse(jsonMatch[0]);
                            }
                        } catch {
                            // JSON parsing failed, use raw output
                        }
                    
                        resolve({
                            success: code === 0,
                            exitCode: code,
                            stdout,
                            stderr,
                            results,
                        });
                    });
                
                    testProcess.on('error', (error) => {
                        console.error('🧪 Test execution error:', error);
                        resolve({
                            success: false,
                            exitCode: -1,
                            stdout: '',
                            stderr: error.message,
                            results: null,
                        });
                    });
            });
        }),

    // Generate optimized Playwright configuration
    generatePlaywrightConfig: t.procedure
        .input(
            z.object({
                testDir: z.string().optional(),
                parallel: z.boolean().optional(),
                workers: z.union([z.number(), z.literal('auto')]).optional(),
                retries: z.number().optional(),
                timeout: z.number().optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            // Check if config already exists
            const exists = await playwrightConfigExists(ctx.projectPath);
            if (exists) {
                return {
                    success: false,
                    path: '',
                    message: 'playwright.config.ts already exists. Delete it first if you want to regenerate.',
                    exists: true,
                };
            }
            
            const result = await writePlaywrightConfig(ctx.projectPath, {
                testDir: input.testDir,
                parallel: input.parallel,
                workers: input.workers,
                retries: input.retries,
                timeout: input.timeout,
            });
            
            return {
                ...result,
                exists: false,
            };
        }),

    // Check if Playwright config exists
    checkPlaywrightConfig: t.procedure
        .query(async ({ ctx }) => {
            const exists = await playwrightConfigExists(ctx.projectPath);
            return { exists };
        }),

    // Interpret test results using AI
    interpretTestResults: t.procedure
        .input(
            z.object({
                testResults: z.array(z.object({
                    name: z.string(),
                    suite: z.string(),
                    status: z.enum(['passed', 'failed', 'skipped']),
                    duration: z.number().optional(),
                    error: z.object({
                        message: z.string().optional(),
                        snippet: z.string().optional(),
                        location: z.object({
                            file: z.string(),
                            line: z.number(),
                            column: z.number(),
                        }).optional(),
                    }).optional(),
                })),
                testCode: z.string(),
                sourceCode: z.string().optional(),
                domContext: z.object({
                    url: z.string(),
                    title: z.string(),
                    interactiveElements: z.array(z.object({
                        tagName: z.string(),
                        role: z.string().optional(),
                        name: z.string().optional(),
                        text: z.string().optional(),
                        testId: z.string().optional(),
                        suggestedSelectors: z.array(z.string()),
                    })),
                    formFields: z.array(z.object({
                        name: z.string(),
                        type: z.string(),
                        label: z.string().optional(),
                        placeholder: z.string().optional(),
                        required: z.boolean(),
                        suggestedSelector: z.string(),
                    })),
                }).optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const apiKey = process.env['OPENROUTER_API_KEY'];
            if (!apiKey) {
                return { interpretation: 'Error: OPENROUTER_API_KEY not configured.', error: true };
            }

            try {
                const context = {
                    testResults: input.testResults,
                    testCode: input.testCode,
                    sourceCode: input.sourceCode,
                    domContext: input.domContext as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                    projectPath: ctx.projectPath,
                };

                const interpretation = await getQuickInterpretation(context, { apiKey });
                return { interpretation, error: false };
            } catch (error) {
                console.error('Interpretation error:', error);
                const raw = error instanceof Error ? error.message : String(error);
                let interpretation = `Error interpreting results: ${raw}`;
                if (raw.includes('402') || raw.includes('credits')) {
                    interpretation = 'Insufficient OpenRouter credits for AI analysis. Please add credits at https://openrouter.ai/settings/credits and try again.';
                }
                return { interpretation, error: true };
            }
        }),

    // ============================================================================
    // Site Discovery Endpoints
    // ============================================================================

    startDiscovery: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url(),
                maxPages: z.number().int().positive().optional(),
                maxDepth: z.number().int().positive().optional(),
                timeout: z.number().int().positive().optional(),
                skipAuth: z.boolean().default(false),
                excludePatterns: z.array(z.string()).optional(),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const runtime = getDiscoveryState(projectPath);
            if (runtime.phase === "running" && discoveryJobStore.has(projectPath)) {
                return {
                    success: false,
                    message: "Discovery is already running",
                    runtime,
                };
            }

            startDiscoveryJob({
                projectPath,
                startUrl: input.url,
                maxPages: input.maxPages,
                maxDepth: input.maxDepth,
                timeout: input.timeout,
                skipAuth: input.skipAuth,
                excludePatterns: input.excludePatterns,
                continueSession: false,
            });

            return {
                success: true,
                message: "Discovery started",
                runtime: getDiscoveryState(projectPath),
            };
        }),

    continueDiscovery: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                skipAuth: z.boolean().default(false),
            })
        )
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            if (discoveryJobStore.has(projectPath)) {
                return {
                    success: false,
                    message: "Discovery is already running",
                    runtime: getDiscoveryState(projectPath),
                };
            }

            const db = new CodeGraphDB(projectPath);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                const activeSession = siteDb.getActiveSession();

                if (!activeSession || activeSession.status !== "paused") {
                    return {
                        success: false,
                        message: "No paused discovery session found",
                        runtime: await hydrateDiscoveryState(projectPath),
                    };
                }

                const resumeUrl = activeSession.blockedAtUrl || activeSession.startUrl;
                startDiscoveryJob({
                    projectPath,
                    startUrl: resumeUrl,
                    maxPages: activeSession.maxPages ?? undefined,
                    maxDepth: activeSession.maxDepth ?? undefined,
                    skipAuth: input.skipAuth,
                    continueSession: true,
                });

                return {
                    success: true,
                    message: "Discovery resumed",
                    runtime: getDiscoveryState(projectPath),
                };
            } finally {
                db.close();
            }
        }),

    getDiscoveryRuntime: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            })
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const hydrated = await hydrateDiscoveryState(projectPath);
            return {
                ...hydrated,
                isRunningInProcess: discoveryJobStore.has(projectPath),
            };
        }),

    getDiscoveryTimeline: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().int().positive().max(MAX_DISCOVERY_EVENTS).default(50),
            })
        )
        .query(({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const state = getDiscoveryState(projectPath);
            return {
                events: state.lastEvents.slice(-input.limit).reverse(),
                total: state.lastEvents.length,
            };
        }),

    authAssist: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            })
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);
            try {
                return discovery.getAuthAssist();
            } catch {
                return {
                    hasUnresolvedBlockers: false,
                    unresolvedCount: 0,
                    suggestedUrl: null,
                    command: "raiken auth --url <login-url>",
                    message: "Unable to inspect auth blockers right now.",
                };
            } finally {
                discovery.close();
            }
        }),

    getDiscoveryStats: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);
            try {
                const stats = discovery.getStats();

                return {
                    ...stats,
                    timestamp: new Date().toISOString(),
                };
            } catch {
                return {
                    pagesCount: 0,
                    linksCount: 0,
                    verifiedLinksCount: 0,
                    brokenLinksCount: 0,
                    authBlockersCount: 0,
                    unresolvedBlockersCount: 0,
                    timestamp: new Date().toISOString(),
                };
            } finally {
                discovery.close();
            }
        }),

    getDiscoverySession: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);

            try {
                const session = discovery.getLatestSession();

                if (!session) {
                    return null;
                }

                return {
                    id: session.id,
                    startUrl: session.startUrl,
                    status: session.status,
                    pagesDiscovered: session.pagesDiscovered,
                    linksFound: session.linksFound,
                    startedAt: toIsoDate(session.startedAt),
                    completedAt: toIsoDate(session.completedAt),
                    blockedAtUrl: session.blockedAtUrl,
                };
            } catch {
                return null;
            } finally {
                discovery.close();
            }
        }),

    getDiscoveredPages: t.procedure
        .input(z.object({
            path: z.string().optional(),
            limit: z.number().default(50),
            offset: z.number().default(0),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);
            try {
                const result = discovery.listPages({ limit: input.limit, offset: input.offset });

                return {
                    pages: result.pages.map(page => ({
                        url: page.url,
                        title: page.title,
                        depth: page.depth,
                        visitCount: page.visitCount,
                        parentUrl: page.parentUrl,
                        discoveredAt: toIsoDate(page.discoveredAt),
                        lastVisitedAt: toIsoDate(page.lastVisitedAt),
                    })),
                    total: result.total,
                    hasMore: result.hasMore,
                };
            } catch {
                return {
                    pages: [],
                    total: 0,
                    hasMore: false,
                };
            } finally {
                discovery.close();
            }
        }),

    getVerifiedLinks: t.procedure
        .input(z.object({
            path: z.string().optional(),
            limit: z.number().default(100),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                const verified = siteDb.getVerifiedLinks();
                const broken = siteDb.getBrokenLinks();

                return {
                    verifiedLinks: verified.slice(0, input.limit).map(link => ({
                        fromUrl: link.fromUrl,
                        toUrl: link.toUrl,
                        selector: link.selector,
                        linkText: link.linkText,
                        elementRole: link.elementRole,
                    })),
                    brokenLinks: broken.slice(0, input.limit).map(link => ({
                        fromUrl: link.fromUrl,
                        toUrl: link.toUrl,
                        selector: link.selector,
                        errorMessage: link.errorMessage,
                    })),
                    verifiedCount: verified.length,
                    brokenCount: broken.length,
                };
            } catch {
                return {
                    verifiedLinks: [],
                    brokenLinks: [],
                    verifiedCount: 0,
                    brokenCount: 0,
                };
            } finally {
                db.close();
            }
        }),

    getDiscoveredPageSnapshot: t.procedure
        .input(z.object({
            path: z.string().optional(),
            url: z.string().url(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);

            try {
                const page = discovery.getPageSnapshot(input.url);

                if (!page) {
                    return null;
                }

                return {
                    url: page.url,
                    normalizedUrl: page.normalizedUrl,
                    title: page.title,
                    snapshotJson: page.snapshotJson,
                    depth: page.depth,
                    discoveredAt: toIsoDate(page.discoveredAt),
                    lastVisitedAt: toIsoDate(page.lastVisitedAt),
                };
            } catch {
                return null;
            } finally {
                discovery.close();
            }
        }),

    getAuthBlockers: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const discovery = new DiscoveryQueryService(projectPath);
            try {
                const blockers = discovery.getUnresolvedBlockers();

                return {
                    blockers: blockers.map(blocker => ({
                        id: blocker.id,
                        url: blocker.url,
                        blockerType: blocker.blockerType,
                        discoveredAt: toIsoDate(blocker.discoveredAt),
                    })),
                    total: blockers.length,
                };
            } catch {
                return {
                    blockers: [],
                    total: 0,
                };
            } finally {
                discovery.close();
            }
        }),

    clearDiscoveryData: t.procedure
        .input(z.object({
            path: z.string().optional(),
        }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;

            const runningJob = discoveryJobStore.get(projectPath);
            if (runningJob) {
                try {
                    await runningJob.discovery.close();
                } catch {
                    // ignore cleanup errors
                } finally {
                    discoveryJobStore.delete(projectPath);
                }
            }

            const db = new CodeGraphDB(projectPath);

            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                siteDb.clearDiscoveryData();
                db.close();

                discoveryRuntimeStore.set(projectPath, createEmptyDiscoveryState());
                pushDiscoveryEvent(projectPath, {
                    type: "cleared",
                    message: "Discovery data cleared",
                });

                return {
                    success: true,
                    message: 'Discovery data cleared successfully',
                    runtime: getDiscoveryState(projectPath),
                };
            } catch (error) {
                db.close();
                return {
                    success: false,
                    message: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
