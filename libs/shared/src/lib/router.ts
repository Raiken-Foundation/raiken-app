// libs/shared/src/lib/router.ts

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    AI_PROVIDER_IDS,
    CodeGraph,
    CodeGraphDB,
    DiscoveryQueryService,
    EmbeddingsGenerator,
    EntryPointDetector,
    formatBytes,
    fullAstToSearchableText,
    getCurrentBranch,
    getQuickInterpretation,
    listProviderModels,
    listProviders,
    ProjectContext,
    parseTicketFromBranch,
    playwrightConfigExists,
    queryTrace,
    readApiKeyFromEnv,
    readPlaywrightBaseURL,
    resolveAIConfig,
    runCi,
    runCover,
    runManualHandoff,
    SiteDiscovery,
    SiteKnowledgeDB,
    scanTests,
    syncCurrentTicket,
    writePlaywrightConfig,
    writeProjectContext,
} from "@raiken/core";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
    loadDiscoveryConfig,
    resolveAuthStorageStateDestination,
    resolveAuthStorageStatePath,
} from "./config";

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
    sender: "user" | "assistant";
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
    type:
        | "page_discovered"
        | "auth_blocked"
        | "session_completed"
        | "error"
        | "warning"
        | "started"
        | "continued"
        | "stopped"
        | "cleared";
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
// Tracks an in-flight `requestBrowserHandoff`. We intentionally only allow
// one headful handoff per project at a time — the user can't drive two
// browsers at once and Playwright's chromium launcher is heavy.
const handoffJobStore: Map<string, Promise<unknown>> = new Map();
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
    patch: Partial<DiscoveryRuntimeState>,
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
    event: Omit<DiscoveryRuntimeEvent, "id" | "timestamp">,
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
    const queryService = getSharedDiscoveryQuery(projectPath);

    try {
        // On first hydration, recover sessions stuck as "running" from a previous crash.
        // Only do this when there is no in-process job (i.e. the server restarted).
        if (!discoveryJobStore.has(projectPath) && current.phase !== "running") {
            const recovered = queryService.recoverStaleSessions();
            if (recovered > 0) {
                console.log(
                    `⚠️  Recovered ${recovered} stale discovery session(s) for ${projectPath}`,
                );
            }
        }

        const stats = queryService.getStats();
        const session = queryService.getLatestSession();

        // `requiresAuth` should reflect *unresolved auth-category* blockers.
        // Non-auth blockers (captcha, manual pause, 5xx) still keep the
        // session paused, but the dashboard surfaces them via the generic
        // BlockerPanel rather than the auth banner.
        const unresolvedBlockers = queryService.getUnresolvedBlockers();
        const hasUnresolvedBlockers = unresolvedBlockers.length > 0;
        const hasUnresolvedAuth = unresolvedBlockers.some((b) => b.category === "auth_required");
        const requiresAuth =
            session?.status === "paused" && Boolean(session.blockedAtUrl) && hasUnresolvedAuth;

        const next = patchDiscoveryState(projectPath, {
            phase: current.phase === "running" ? "running" : toDiscoveryPhase(session?.status),
            startedAt:
                typeof session?.startedAt === "number"
                    ? new Date(session.startedAt).toISOString()
                    : current.startedAt,
            pagesDiscovered: stats.pagesCount,
            linksFound: stats.linksCount,
            authBlockersFound: stats.unresolvedBlockersCount,
            blockedAtUrl:
                hasUnresolvedBlockers && session?.status === "paused"
                    ? (session?.blockedAtUrl ?? null)
                    : null,
            requiresAuth,
            currentUrl: current.currentUrl ?? session?.blockedAtUrl ?? null,
            lastError: current.lastError,
        });

        // Generalised auto-resume. The previous logic was welded to auth:
        // it only fired when `wasWaitingForAuth && !hasUnresolvedBlockers`.
        // Now we auto-resume whenever the session was waiting on *any*
        // blocker and every blocker has either been marked resolved or
        // explicitly resolved with skip/ignore/clear/etc. Manual pauses
        // (`category === "manual"`) deliberately don't auto-resume — the
        // user said "I'm driving now", they get to click Continue.
        const wasWaitingForBlocker =
            current.requiresAuth ||
            current.phase === "paused" ||
            (current.authBlockersFound ?? 0) > 0;
        // We only auto-resume if every detected blocker now has a recorded
        // resolution. `getUnresolvedBlockers` returns rows with no
        // `resolved_at` regardless of category, so a manual pause
        // (`category === "manual"`) keeps `unresolvedBlockers.length > 0`
        // and the crawl stays paused until the user explicitly resolves
        // it via `continueDiscovery`. That's the contract we promised the
        // user: "I'm driving now" means the dashboard never restarts the
        // crawl behind their back.
        const everyBlockerResolved = unresolvedBlockers.length === 0;
        if (
            wasWaitingForBlocker &&
            everyBlockerResolved &&
            session?.status === "paused" &&
            !discoveryJobStore.has(projectPath) &&
            !autoResumeInFlight.has(projectPath)
        ) {
            autoResumeInFlight.add(projectPath);
            queueMicrotask(() => {
                try {
                    // Detect *how* the most recent blockers were resolved so
                    // the auto-resume can mirror what an explicit
                    // `continueDiscovery({ resolution: "provide_state" })`
                    // would do. Without this the auto-resume races the
                    // dashboard's explicit resume call: the poll fires first
                    // with `startUrl = blockedAtUrl` and *no* queue purge,
                    // Crawlee finds /login already "handled", and the crawl
                    // completes after a single page even though fresh auth
                    // state was just dropped on disk. See the discovery view
                    // logs that show "Resumed discovery at .../login" right
                    // after a successful handoff for the symptom this fixes.
                    const allBlockers = queryService.getAllBlockers();
                    const recentlyResolved = allBlockers.filter((b) => b.resolvedAt != null);
                    const stateProvidingResolutions = new Set(["handoff", "provide_state"]);
                    const resolvedViaState = recentlyResolved.some(
                        (b) =>
                            (b.resolution && stateProvidingResolutions.has(b.resolution)) ||
                            Boolean(b.storageStatePath),
                    );
                    // `clear` resolutions don't carry a storage path, but if
                    // an `auth-state.json` showed up on disk while the
                    // session was paused (e.g. user ran `raiken auth` out of
                    // band) we still want to re-crawl from startUrl so the
                    // post-login link graph becomes visible.
                    const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
                    const hasFreshAuthState = fsSync.existsSync(authStatePath);
                    const purgeQueueOnResume = resolvedViaState || hasFreshAuthState;
                    const resumeUrl = purgeQueueOnResume
                        ? session.startUrl
                        : session.blockedAtUrl || session.startUrl;
                    if (!resumeUrl) return;
                    console.log(
                        `🔁 Auto-resuming discovery for ${projectPath} after blockers cleared (purge=${purgeQueueOnResume}, url=${resumeUrl})`,
                    );
                    pushDiscoveryEvent(projectPath, {
                        type: "continued",
                        message: purgeQueueOnResume
                            ? `Blockers cleared with new auth state — re-crawling from ${resumeUrl}`
                            : "Blockers cleared — auto-resuming discovery",
                    });
                    startDiscoveryJob({
                        projectPath,
                        startUrl: resumeUrl,
                        maxPages: session.maxPages ?? undefined,
                        maxDepth: session.maxDepth ?? undefined,
                        continueSession: true,
                        purgeQueueOnResume,
                    });
                } catch (err) {
                    console.warn(
                        `Auto-resume failed for ${projectPath}:`,
                        err instanceof Error ? err.message : err,
                    );
                } finally {
                    autoResumeInFlight.delete(projectPath);
                }
            });
        }

        return next;
    } catch {
        return current;
    }
}

// Tracks which projects already have an auto-resume scheduled, so we don't
// fire multiple `startDiscoveryJob` calls in parallel from rapid-fire polls.
const autoResumeInFlight: Set<string> = new Set();

/**
 * S9: Polling the discovery view fires ~7 read queries every 4 seconds. Each
 * one used to open & close a fresh better-sqlite3 connection (which also
 * runs schema migrations on construction). Cache one DiscoveryQueryService
 * per project and reuse it across queries. Invalidated on `clearDiscoveryData`.
 */
const sharedDiscoveryQueryServices: Map<string, DiscoveryQueryService> = new Map();

function getSharedDiscoveryQuery(projectPath: string): DiscoveryQueryService {
    let svc = sharedDiscoveryQueryServices.get(projectPath);
    if (!svc) {
        svc = new DiscoveryQueryService(projectPath);
        sharedDiscoveryQueryServices.set(projectPath, svc);
    }
    return svc;
}

function invalidateSharedDiscoveryQuery(projectPath: string): void {
    const svc = sharedDiscoveryQueryServices.get(projectPath);
    if (svc) {
        try {
            svc.close();
        } catch {
            // ignore
        }
        sharedDiscoveryQueryServices.delete(projectPath);
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

    // Generic blocker stream. Replaces the auth-only listener with a
    // category-aware one so the dashboard's `requiresAuth` flag only flips
    // for actual auth blockers, while non-auth pauses (captcha, manual,
    // 5xx) still stop the crawl and surface in the timeline.
    const handleBlockerEvent = (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: {
                blocker?: {
                    url?: string;
                    blockerType?: string;
                    category?: string;
                    severity?: string;
                };
            };
        };
        const blocker = payload.data?.blocker;
        const category = (blocker?.category ?? "auth_required") as string;
        const severity = (blocker?.severity ?? "pause") as string;
        const isAuth = category === "auth_required";
        const state = getDiscoveryState(projectPath);
        // Severity "log" means "we recorded it but kept going"; don't flip
        // phase or requiresAuth in that case — just timeline it.
        if (severity !== "log") {
            patchDiscoveryState(projectPath, {
                phase: "paused",
                blockedAtUrl: blocker?.url ?? state.currentUrl,
                requiresAuth: isAuth,
                authBlockersFound: state.authBlockersFound + 1,
                currentUrl: blocker?.url ?? state.currentUrl,
            });
        } else {
            patchDiscoveryState(projectPath, {
                authBlockersFound: state.authBlockersFound + 1,
            });
        }
        const verb = isAuth ? "Authentication required" : `Blocker (${category})`;
        pushDiscoveryEvent(projectPath, {
            type: "auth_blocked",
            message: blocker?.url ? `${verb} at ${blocker.url}` : verb,
            data: {
                url: blocker?.url ?? null,
                category,
                severity,
                blockerType: blocker?.blockerType ?? null,
            },
        });
    };
    discovery.on("blocker_detected", handleBlockerEvent);
    // `auth_blocked` is dual-emitted by the crawler for one release; ignore
    // it here so we don't double-count the same blocker twice.

    discovery.on("session_paused", () => {
        const state = getDiscoveryState(projectPath);
        patchDiscoveryState(projectPath, {
            phase: "paused",
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
                reason?: "aborted";
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
        const finalPages =
            typeof stats?.pagesDiscovered === "number"
                ? stats.pagesDiscovered
                : prevState.pagesDiscovered;

        let completionReason: string | null = null;
        if (payload.data?.reason === "aborted") {
            completionReason = "Stopped by user";
        } else if (prevState.maxPages && finalPages >= prevState.maxPages) {
            completionReason = `Reached page limit (${prevState.maxPages})`;
        } else if (
            prevState.maxDepth &&
            typeof stats?.currentDepth === "number" &&
            stats.currentDepth >= prevState.maxDepth
        ) {
            completionReason = `Reached depth limit (${prevState.maxDepth})`;
        } else {
            completionReason = "All reachable pages crawled";
        }

        patchDiscoveryState(projectPath, {
            phase: "completed",
            currentUrl: stats?.currentUrl ?? null,
            currentDepth: typeof stats?.currentDepth === "number" ? stats.currentDepth : 0,
            pagesDiscovered: finalPages,
            linksFound:
                typeof stats?.linksFound === "number" ? stats.linksFound : prevState.linksFound,
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

    discovery.on("snapshot_failed", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: { url?: string; message?: string };
        };
        const url = payload.data?.url ?? "(unknown url)";
        const reason = payload.data?.message ?? "unknown error";
        pushDiscoveryEvent(projectPath, {
            type: "warning",
            message: `Snapshot failed at ${url}: ${reason}`,
            data: { url, reason },
        });
    });

    // Crawler-level navigation failures (Playwright nav errors, retry
    // exhaustion, anti-bot kills, ...). Surface them in the timeline so the
    // "0 pages discovered" terminal error isn't the user's first signal
    // that something went wrong.
    discovery.on("warning", (event: unknown) => {
        const payload = (event ?? {}) as {
            data?: { url?: string; message?: string; status?: number | null };
        };
        const url = payload.data?.url ?? "(unknown url)";
        const message = payload.data?.message ?? "Warning";
        pushDiscoveryEvent(projectPath, {
            type: "warning",
            message: `${message} at ${url}`,
            data: payload.data ?? { url, message },
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
    /**
     * Forwarded to `SiteDiscovery.purgeQueueOnResume`. Set after a
     * resolution that materially changes what the crawler can see (auth
     * handoff, fresh storage state) so we re-crawl from `startUrl`
     * instead of replaying the pre-resolution queue.
     */
    purgeQueueOnResume?: boolean;
}): void {
    if (discoveryJobStore.has(options.projectPath)) {
        throw new Error("Discovery is already running for this project");
    }

    const config = loadDiscoveryConfig(options.projectPath);
    const storageStatePath = resolveAuthStorageStatePath(options.projectPath);
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
        purgeQueueOnResume: options.purgeQueueOnResume ?? false,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
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
            // `discovery.close()` is best-effort; we never want a cleanup
            // error to escape this IIFE because it would surface as an
            // unhandled promise rejection and (under Node 22's default
            // policy) crash the entire CLI server. The crawler itself
            // already swallows teardown errors, but we double-belt this
            // boundary to keep the discovery loop fully isolated from
            // the request lifecycle.
            try {
                await discovery.close();
            } catch {
                // Already logged inside SiteDiscovery.close via warning event.
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
            version: "0.3.0",
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
            }),
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

    // ============================================================================
    // AI provider catalog & model discovery
    // ============================================================================

    listAIProviders: t.procedure.query(({ ctx }) => {
        const resolved = resolveAIConfig(ctx.projectPath);
        return {
            providers: listProviders().map((p) => ({
                id: p.id,
                label: p.label,
                description: p.description,
                defaultModel: p.defaultModel,
                defaultBaseURL: p.defaultBaseURL,
                envVars: p.envVars,
                publicCatalog: p.publicCatalog,
                apiKeyUrl: p.apiKeyUrl,
                apiKeyPlaceholder: p.apiKeyPlaceholder,
                /** Whether this provider has a usable API key (env or config). */
                hasKey: Boolean(readApiKeyFromEnv(p.id)),
            })),
            current: {
                provider: resolved.provider,
                model: resolved.model,
                baseURL: resolved.baseURL,
                hasKey: resolved.apiKeySource !== "none",
                apiKeySource: resolved.apiKeySource,
                apiKeyEnvVar: resolved.apiKeyEnvVar ?? null,
            },
        };
    }),

    listAIModels: t.procedure
        .input(
            z.object({
                provider: z.enum(AI_PROVIDER_IDS),
                /** Optional override key — UI passes the freshly-typed key
                 *  before save so users can browse models pre-commit. */
                apiKey: z.string().optional(),
                baseURL: z.string().optional(),
            }),
        )
        .query(async ({ input }) => {
            const result = await listProviderModels({
                provider: input.provider,
                apiKey: input.apiKey,
                baseURL: input.baseURL,
            });
            return {
                provider: input.provider,
                models: result.models,
                error: result.error ?? null,
                count: result.models.length,
            };
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
                sender: z.enum(["user", "assistant"]),
                timestamp: z.number(),
                fileMentions: z.array(z.string()).optional(),
            }),
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
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(100),
                offset: z.number().default(0),
            }),
        )
        .query(async ({ input }) => {
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
        .query(async ({ input }) => {
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
        .query(async ({ input }) => {
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

    getAffectedTests: t.procedure
        .input(
            z.object({
                changedFiles: z.array(z.string()),
                path: z.string().optional(),
            }),
        )
        .query(({ input }) => {
            const projectPath = input.path || process.cwd();
            const db = new CodeGraphDB(projectPath);
            const results = db.getAffectedTests(input.changedFiles);
            db.close();
            return { affected: results, timestamp: new Date().toISOString() };
        }),

    reindexFiles: t.procedure
        .input(
            z.object({
                files: z.array(z.string()),
                path: z.string().optional(),
            }),
        )
        .mutation(async ({ input }) => {
            const projectPath = input.path || process.cwd();
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
        }),

    // ============================================================================
    // Ticket Integration Endpoints
    // ============================================================================

    syncTicket: t.procedure
        .input(
            z.object({
                ticketId: z.string().optional(),
                path: z.string().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;

            let integrationConfig: Record<string, unknown> | undefined;
            let aiConfig: { apiKey?: string; model?: string; baseURL?: string } | undefined;

            try {
                const configContent = await fs.readFile(
                    path.join(projectPath, "raiken.config.json"),
                    "utf-8",
                );
                const raw = JSON.parse(configContent);
                integrationConfig = raw?.integrations;
                aiConfig = {
                    apiKey: raw?.ai?.apiKey || process.env["OPENROUTER_API_KEY"],
                    model: raw?.ai?.model,
                    baseURL: raw?.ai?.baseURL,
                };
            } catch {
                aiConfig = { apiKey: process.env["OPENROUTER_API_KEY"] };
            }

            const result = await syncCurrentTicket({
                projectPath,
                config: integrationConfig as Parameters<typeof syncCurrentTicket>[0]["config"],
                ticketId: input.ticketId,
                ai: aiConfig,
            });

            return result;
        }),

    getTicketStatus: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const branch = getCurrentBranch(projectPath);
            if (!branch) {
                return { branch: null, ticket: null };
            }

            let integrationConfig: Record<string, unknown> | undefined;
            try {
                const configContent = fsSync.readFileSync(
                    path.join(projectPath, "raiken.config.json"),
                    "utf-8",
                );
                integrationConfig = JSON.parse(configContent)?.integrations;
            } catch {
                // no config
            }

            const parsed = parseTicketFromBranch(
                branch,
                integrationConfig as Parameters<typeof parseTicketFromBranch>[1],
            );

            return {
                branch,
                ticket: parsed ? { id: parsed.ticketId, provider: parsed.provider } : null,
            };
        }),

    saveGeneratedTest: t.procedure
        .input(
            z.object({
                fileName: z.string(),
                content: z.string(),
                testDir: z.string().optional(),
                sourceFiles: z.array(z.string()).optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const { fileName, testDir: customTestDir, sourceFiles } = input;
            let { content } = input;

            // Extract code from markdown fences if present
            const fenceMatch = content.match(
                /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i,
            );
            if (fenceMatch) {
                content = fenceMatch[1];
            } else {
                // Fallback: strip opening fence from start
                content = content.replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/i, "");
                // Strip closing fence and anything after it
                const closingIdx = content.lastIndexOf("\n```");
                if (closingIdx !== -1) {
                    content = content.substring(0, closingIdx);
                }
            }
            content = content.trim();

            // Load test directory from raiken.config.json if exists
            let testDirectory = customTestDir || "e2e";
            const configPath = path.join(ctx.projectPath, "raiken.config.json");

            try {
                const configContent = await fs.readFile(configPath, "utf-8");
                const config = JSON.parse(configContent);
                testDirectory = config.testDirectory || testDirectory;
            } catch {
                // Use default or provided testDir
            }

            // Validate filename
            if (!fileName.match(/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/)) {
                throw new Error(
                    "Invalid filename. Must be a test file (*.spec.ts, *.test.tsx, etc.)",
                );
            }

            // Prevent directory traversal
            if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
                throw new Error(
                    "Filename must not contain path separators or parent directory references",
                );
            }

            // Create test directory if it doesn't exist
            const testDirPath = path.join(ctx.projectPath, testDirectory);
            await fs.mkdir(testDirPath, { recursive: true });

            // Write the test file
            const filePath = path.join(testDirPath, fileName);
            await fs.writeFile(filePath, content, "utf-8");

            console.log(`✓ Saved generated test: ${path.relative(ctx.projectPath, filePath)}`);

            if (sourceFiles && sourceFiles.length > 0) {
                try {
                    const db = new CodeGraphDB(ctx.projectPath);
                    db.recordTestSourceFiles(path.relative(ctx.projectPath, filePath), sourceFiles);
                    db.close();
                } catch (err) {
                    console.warn("Failed to record test source mapping:", err);
                }
            }

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
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const resolved = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(ctx.projectPath, input.filePath);

            // Prevent writes outside project
            if (!resolved.startsWith(ctx.projectPath)) {
                throw new Error("Cannot write files outside the project directory");
            }

            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, input.content, "utf-8");
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
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const resolved = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(ctx.projectPath, input.filePath);

            if (!resolved.startsWith(ctx.projectPath)) {
                throw new Error("Cannot delete files outside the project directory");
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
            }),
        )
        .query(async ({ input, ctx }) => {
            // Load test directory from raiken.config.json if exists
            let testDirectory = input.testDir || "e2e";
            const configPath = path.join(ctx.projectPath, "raiken.config.json");

            try {
                const configContent = await fs.readFile(configPath, "utf-8");
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
            async function scanDir(dirPath: string, relativePath = "") {
                try {
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });

                    for (const entry of entries) {
                        const entryPath = path.join(dirPath, entry.name);
                        const entryRelPath = relativePath
                            ? `${relativePath}/${entry.name}`
                            : entry.name;

                        if (entry.isDirectory()) {
                            await scanDir(entryPath, entryRelPath);
                        } else if (entry.isFile()) {
                            // Check if it's a test file
                            if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                                testFiles.push({
                                    name: entry.name,
                                    path: `${testDirectory}/${entryRelPath}`,
                                    directory:
                                        testDirectory + (relativePath ? `/${relativePath}` : ""),
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
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const { spawn } = await import("node:child_process");

            // Auto-create playwright.config.ts if one doesn't exist
            let configPath = await findPlaywrightConfigPath(ctx.projectPath);
            if (!configPath) {
                const result = await writePlaywrightConfig(ctx.projectPath, {
                    testDir: "./e2e",
                });
                if (result.success) {
                    configPath = result.path;
                    console.log("🧪 Auto-created playwright.config.ts");
                }
            }

            return new Promise((resolve) => {
                const args = ["test"];

                // Add specific test file if provided
                if (input.testFile) {
                    args.push(input.testFile);
                }

                // Add test name filter if provided
                if (input.testName) {
                    args.push("-g", input.testName);
                }

                // Performance options - only add workers if explicitly set to a number
                // Omitting --workers flag lets Playwright auto-detect
                if (input.workers !== undefined && typeof input.workers === "number") {
                    args.push(`--workers=${input.workers}`);
                }

                // Add reporter for structured output
                args.push("--reporter=json");

                if (configPath) {
                    args.push("--config", configPath);
                }

                console.log(`🧪 Running tests: npx playwright ${args.join(" ")}`);
                console.log(`🧪 Using config: ${configPath || "default"}`);

                const testProcess = spawn("npx", ["playwright", ...args], {
                    cwd: ctx.projectPath,
                    shell: true,
                    env: { ...process.env, FORCE_COLOR: "0" },
                });

                let stdout = "";
                let stderr = "";

                testProcess.stdout?.on("data", (data) => {
                    stdout += data.toString();
                });

                testProcess.stderr?.on("data", (data) => {
                    stderr += data.toString();
                });

                testProcess.on("close", (code) => {
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

                testProcess.on("error", (error) => {
                    console.error("🧪 Test execution error:", error);
                    resolve({
                        success: false,
                        exitCode: -1,
                        stdout: "",
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
                workers: z.union([z.number(), z.literal("auto")]).optional(),
                retries: z.number().optional(),
                timeout: z.number().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            // Check if config already exists
            const exists = await playwrightConfigExists(ctx.projectPath);
            if (exists) {
                return {
                    success: false,
                    path: "",
                    message:
                        "playwright.config.ts already exists. Delete it first if you want to regenerate.",
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
    checkPlaywrightConfig: t.procedure.query(async ({ ctx }) => {
        const exists = await playwrightConfigExists(ctx.projectPath);
        return { exists };
    }),

    // Interpret test results using AI.
    //
    // Schema includes everything the dashboard already has on screen for
    // a failing run — `attachments` per result, the raw `rawOutput` from
    // Playwright, and the actual `testFilePath` of the file that ran.
    // Pre-fix the dashboard was sending only `testResults` (without
    // attachments) and `testCode` (taken from whichever editor tab was
    // active, not the file that actually ran), so the model invented
    // explanations that diverged from the on-disk artifacts. See
    // `libs/core/src/testing/interpreter.ts` for the prompt + budget
    // rationale.
    interpretTestResults: t.procedure
        .input(
            z.object({
                testResults: z.array(
                    z.object({
                        name: z.string(),
                        suite: z.string(),
                        status: z.enum(["passed", "failed", "skipped"]),
                        duration: z.number().optional(),
                        error: z
                            .object({
                                message: z.string().optional(),
                                snippet: z.string().optional(),
                                location: z
                                    .object({
                                        file: z.string(),
                                        line: z.number(),
                                        column: z.number(),
                                    })
                                    .optional(),
                            })
                            .optional(),
                        attachments: z
                            .array(
                                z.object({
                                    name: z.string(),
                                    contentType: z.string().optional(),
                                    path: z.string().optional(),
                                }),
                            )
                            .optional(),
                    }),
                ),
                testCode: z.string(),
                /**
                 * Path of the file whose results are being interpreted. The
                 * model uses this to flag context-mismatch when the supplied
                 * code doesn't contain the locator that Playwright is waiting
                 * for in the call log.
                 */
                testFilePath: z.string().optional(),
                /**
                 * Full Playwright stdout/stderr for the run. Truncated tail-
                 * first inside the prompt builder so the most-recent (and most
                 * actionable) lines survive.
                 */
                rawOutput: z.string().optional(),
                sourceCode: z.string().optional(),
                domContext: z
                    .object({
                        url: z.string(),
                        title: z.string(),
                        interactiveElements: z.array(
                            z.object({
                                tagName: z.string(),
                                role: z.string().optional(),
                                name: z.string().optional(),
                                text: z.string().optional(),
                                testId: z.string().optional(),
                                suggestedSelectors: z.array(z.string()),
                            }),
                        ),
                        formFields: z.array(
                            z.object({
                                name: z.string(),
                                type: z.string(),
                                label: z.string().optional(),
                                placeholder: z.string().optional(),
                                required: z.boolean(),
                                suggestedSelector: z.string(),
                            }),
                        ),
                    })
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const apiKey = process.env["OPENROUTER_API_KEY"];
            if (!apiKey) {
                return {
                    interpretation: "Error: OPENROUTER_API_KEY not configured.",
                    error: true,
                    // Included so the response shape is uniform across all
                    // branches — keeps the dashboard's `data.testCodeSource`
                    // access type-safe without an extra narrowing.
                    testCodeSource: null as
                        | "disk"
                        | "client-snapshot"
                        | "client-snapshot-fallback"
                        | null,
                };
            }

            // Prefer the file on disk over whatever the client snapshotted.
            // Rationale: Playwright reads test files from disk at run time,
            // so the on-disk version is what *actually produced* the failing
            // results. The client snapshot is only used as a fallback when
            // (a) no path was supplied, (b) the path is a scratch buffer
            // (no disk file), (c) the path resolves outside the project
            // directory (path-traversal guard), or (d) the read fails for
            // any reason.
            let testCode = input.testCode;
            let testCodeSource: "disk" | "client-snapshot" | "client-snapshot-fallback" =
                "client-snapshot";
            const rawPath = input.testFilePath;
            if (rawPath && !rawPath.startsWith("scratch:")) {
                const projectRoot = path.resolve(ctx.projectPath);
                const candidate = path.isAbsolute(rawPath)
                    ? path.resolve(rawPath)
                    : path.resolve(ctx.projectPath, rawPath);
                // Path-traversal guard. The mutation accepts an arbitrary
                // string from the dashboard; without this an attacker (or a
                // bug in the client) could trick the server into reading
                // `/etc/passwd`. Constrain to files under projectRoot.
                const insideProject =
                    candidate === projectRoot || candidate.startsWith(`${projectRoot}${path.sep}`);
                if (insideProject) {
                    try {
                        testCode = await fs.readFile(candidate, "utf-8");
                        testCodeSource = "disk";
                    } catch {
                        // ENOENT / EACCES / etc. Keep client snapshot, but
                        // flag in the response so the dashboard can warn.
                        testCodeSource = "client-snapshot-fallback";
                    }
                } else {
                    testCodeSource = "client-snapshot-fallback";
                }
            }

            try {
                const context = {
                    testResults: input.testResults,
                    testCode,
                    testFilePath: input.testFilePath,
                    rawOutput: input.rawOutput,
                    sourceCode: input.sourceCode,
                    domContext: input.domContext as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                    projectPath: ctx.projectPath,
                };

                const interpretation = await getQuickInterpretation(context, { apiKey });
                return { interpretation, error: false, testCodeSource };
            } catch (error) {
                console.error("Interpretation error:", error);
                const raw = error instanceof Error ? error.message : String(error);
                let interpretation = `Error interpreting results: ${raw}`;
                if (raw.includes("402") || raw.includes("credits")) {
                    interpretation =
                        "Insufficient OpenRouter credits for AI analysis. Please add credits at https://openrouter.ai/settings/credits and try again.";
                }
                return { interpretation, error: true, testCodeSource };
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
            }),
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

    /**
     * Resume (or apply a resolution to) a paused discovery session.
     *
     * The `resolution` discriminated union lets the dashboard tell us what
     * the user actually decided about the blocker(s):
     *   - `clear`            "I fixed it, just retry the same URL"
     *   - `skip`             "skip THIS URL, keep crawling everything else"
     *   - `ignore_category`  "stop pausing for this category this session"
     *   - `provide_state`    "I dropped a Playwright storageState here"
     *
     * Behavior:
     *   - The targeted blocker is marked resolved with the chosen resolution.
     *   - For `skip` / `ignore_category` we also persist the choice in
     *     session-scoped memory so a pause/resume cycle remembers it.
     *   - The crawl then resumes from the original blocked URL (or, for
     *     `skip`, from `startUrl` if the only thing left was the skipped one).
     *
     * Back-compat: callers that pass no `resolution` (or `clear`) get the
     * historical "just resume from blockedAtUrl" behavior, which is what the
     * pre-refactor `continueDiscovery` did.
     */
    continueDiscovery: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                skipAuth: z.boolean().default(false),
                resolution: z
                    .enum(["clear", "skip", "ignore_category", "provide_state"])
                    .default("clear"),
                blockerId: z.number().int().positive().optional(),
                category: z
                    .enum([
                        "auth_required",
                        "captcha",
                        "consent_wall",
                        "rate_limited",
                        "geo_blocked",
                        "interstitial",
                        "error_page",
                        "manual",
                        "unknown",
                    ])
                    .optional(),
                storageStatePath: z.string().optional(),
            }),
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

                // --------------------------------------------------------
                // Resolve blockers per the user's choice. We always touch
                // the targeted blocker (if any) plus, for sweeping
                // resolutions like `provide_state`, every other unresolved
                // auth blocker so the next start doesn't immediately
                // re-pause on a stale row.
                // --------------------------------------------------------
                const resolution = input.resolution;
                const targetBlocker = input.blockerId ? siteDb.getBlocker(input.blockerId) : null;

                let skipUrl: string | null = null;
                let resumeStartUrl = activeSession.blockedAtUrl || activeSession.startUrl;
                // Set when the chosen resolution materially changes what the
                // crawler will see on reload (e.g. fresh auth state means the
                // post-login DOM exposes new nav links). Forces the crawler
                // to drop Crawlee's persistent "URL already handled" log and
                // re-crawl from `startUrl`.
                let purgeQueueOnResume = false;

                if (resolution === "skip") {
                    skipUrl = targetBlocker?.url ?? activeSession.blockedAtUrl ?? null;
                    if (skipUrl) {
                        siteDb.updateSession(activeSession.id!, {
                            skippedUrlsJson: JSON.stringify(
                                Array.from(
                                    new Set([
                                        ...(activeSession.skippedUrlsJson
                                            ? (JSON.parse(
                                                  activeSession.skippedUrlsJson,
                                              ) as string[])
                                            : []),
                                        skipUrl,
                                    ]),
                                ),
                            ),
                        });
                    }
                    if (input.blockerId) {
                        siteDb.markBlockerResolved(input.blockerId, {
                            resolution: "skip",
                            resolvedVia: "dashboard",
                        });
                    }
                    // Don't restart the crawl at the skipped URL.
                    resumeStartUrl = activeSession.startUrl;
                } else if (resolution === "ignore_category") {
                    const category = input.category ?? targetBlocker?.category ?? "auth_required";
                    siteDb.updateSession(activeSession.id!, {
                        ignoredCategoriesJson: JSON.stringify(
                            Array.from(
                                new Set([
                                    ...(activeSession.ignoredCategoriesJson
                                        ? (JSON.parse(
                                              activeSession.ignoredCategoriesJson,
                                          ) as string[])
                                        : []),
                                    category,
                                ]),
                            ),
                        ),
                    });
                    if (input.blockerId) {
                        siteDb.markBlockerResolved(input.blockerId, {
                            resolution: "ignore_category",
                            resolvedVia: "dashboard",
                        });
                    } else {
                        // Bulk-resolve everything in that category so we
                        // don't immediately re-pause on a sibling row.
                        const all = siteDb.getUnresolvedBlockers();
                        for (const b of all) {
                            if (b.category === category && b.id) {
                                siteDb.markBlockerResolved(b.id, {
                                    resolution: "ignore_category",
                                    resolvedVia: "dashboard",
                                });
                            }
                        }
                    }
                } else if (resolution === "provide_state") {
                    const path = input.storageStatePath ?? null;
                    if (input.blockerId) {
                        siteDb.markBlockerResolved(input.blockerId, {
                            resolution: "provide_state",
                            resolvedVia: "dashboard",
                            storageStatePath: path,
                        });
                    }
                    // Sweep all unresolved auth blockers — they all share
                    // the storage state as their resolution artifact.
                    const all = siteDb.getUnresolvedBlockers();
                    for (const b of all) {
                        if (b.category === "auth_required" && b.id) {
                            siteDb.markBlockerResolved(b.id, {
                                resolution: "provide_state",
                                resolvedVia: "dashboard",
                                storageStatePath: path,
                            });
                        }
                    }
                    // Re-crawl from the original start URL with the new
                    // state so we discover the post-login link graph
                    // (Navbar, dashboard, etc.). Resuming from
                    // `blockedAtUrl` would just hit the SPA's redirect to
                    // the post-login page, and Crawlee's persistent queue
                    // would skip it as "already handled".
                    purgeQueueOnResume = true;
                    resumeStartUrl = activeSession.startUrl;
                } else {
                    // `clear` — historical behavior: clear targeted blocker
                    // (or every unresolved one if no id given) and resume.
                    if (input.blockerId) {
                        siteDb.markBlockerResolved(input.blockerId, {
                            resolution: "clear",
                            resolvedVia: "dashboard",
                        });
                    } else {
                        siteDb.resolveAllBlockers({
                            resolution: "clear",
                            resolvedVia: "dashboard",
                        });
                    }

                    // If the user cleared an auth blocker AND we now have an
                    // auth-state.json on disk that wasn't there when the
                    // session paused, treat this as "auth was just handled
                    // out-of-band" (e.g. via `raiken auth`). Re-crawl from
                    // startUrl so the post-login link graph is discovered.
                    const targetIsAuth =
                        targetBlocker?.category === "auth_required" ||
                        input.category === "auth_required";
                    if (targetIsAuth) {
                        const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
                        if (fsSync.existsSync(authStatePath)) {
                            purgeQueueOnResume = true;
                            resumeStartUrl = activeSession.startUrl;
                        }
                    }
                }

                startDiscoveryJob({
                    projectPath,
                    startUrl: resumeStartUrl,
                    maxPages: activeSession.maxPages ?? undefined,
                    maxDepth: activeSession.maxDepth ?? undefined,
                    skipAuth: input.skipAuth,
                    continueSession: true,
                    purgeQueueOnResume,
                });

                return {
                    success: true,
                    message: purgeQueueOnResume
                        ? `Discovery re-crawling from ${resumeStartUrl} with new state (resolution: ${resolution})`
                        : `Discovery resumed (resolution: ${resolution})`,
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
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const hydrated = await hydrateDiscoveryState(projectPath);
            return {
                ...hydrated,
                isRunningInProcess: discoveryJobStore.has(projectPath),
            };
        }),

    /**
     * Smart defaults the Discovery form should pre-fill from the project's
     * own configuration — currently just `use.baseURL` from
     * `playwright.config.{ts,js,mjs,cjs}`.
     *
     * Why this exists: Issue 5. The dashboard previously hardcoded the
     * placeholder to `http://localhost:3000`, which forced every user
     * whose dev server runs on a different port (Next.js stable on
     * `:3000`, Vite on `:5173`, this fixture on `:5100`, …) to retype
     * the URL the rest of Raiken (test generation, doctor, port
     * detector) had already detected automatically.
     *
     * Returns `{ baseURL: null }` when no static literal could be
     * extracted (no config, dynamic value, etc.) so the dashboard can
     * fall back to its old generic placeholder without surprising the
     * user with a guess.
     */
    getDiscoveryDefaults: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const baseURL = await readPlaywrightBaseURL(projectPath);
                return { baseURL };
            } catch {
                return { baseURL: null };
            }
        }),

    getDiscoveryTimeline: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().int().positive().max(MAX_DISCOVERY_EVENTS).default(50),
            }),
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
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                return getSharedDiscoveryQuery(projectPath).getAuthAssist();
            } catch {
                return {
                    hasUnresolvedBlockers: false,
                    unresolvedCount: 0,
                    suggestedUrl: null,
                    command: "raiken auth --url <login-url>",
                    message: "Unable to inspect auth blockers right now.",
                };
            }
        }),

    getDiscoveryStats: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const stats = getSharedDiscoveryQuery(projectPath).getStats();
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
            }
        }),

    getDiscoverySession: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const session = getSharedDiscoveryQuery(projectPath).getLatestSession();
                if (!session) return null;

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
            }
        }),

    getDiscoveredPages: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(50),
                offset: z.number().default(0),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const result = getSharedDiscoveryQuery(projectPath).listPages({
                    limit: input.limit,
                    offset: input.offset,
                });
                return {
                    pages: result.pages.map((page) => ({
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
            }
        }),

    getVerifiedLinks: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(100),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const db = new CodeGraphDB(projectPath);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                const verified = siteDb.getVerifiedLinks();
                const broken = siteDb.getBrokenLinks();

                return {
                    verifiedLinks: verified.slice(0, input.limit).map((link) => ({
                        fromUrl: link.fromUrl,
                        toUrl: link.toUrl,
                        selector: link.selector,
                        linkText: link.linkText,
                        elementRole: link.elementRole,
                    })),
                    brokenLinks: broken.slice(0, input.limit).map((link) => ({
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
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const page = getSharedDiscoveryQuery(projectPath).getPageSnapshot(input.url);
                if (!page) return null;
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
            }
        }),

    getAuthBlockers: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            try {
                const blockers = getSharedDiscoveryQuery(projectPath).getUnresolvedBlockers();
                return {
                    // Keep the legacy `blockerType` field for back-compat,
                    // but also surface the new generic shape so the
                    // BlockerPanel can render category badges and per-row
                    // resolution actions.
                    blockers: blockers.map((blocker) => ({
                        id: blocker.id,
                        url: blocker.url,
                        blockerType: blocker.blockerType,
                        category: blocker.category,
                        severity: blocker.severity,
                        detectorId: blocker.detectorId,
                        evidenceJson: blocker.evidenceJson,
                        screenshotPath: blocker.screenshotPath,
                        discoveredAt: toIsoDate(blocker.discoveredAt),
                    })),
                    total: blockers.length,
                };
            } catch {
                return { blockers: [], total: 0 };
            }
        }),

    clearDiscoveryData: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
            }),
        )
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

            // S9: drop the shared DB handle so the next read sees a fresh
            // connection against the now-empty database.
            invalidateSharedDiscoveryQuery(projectPath);

            const db = new CodeGraphDB(projectPath);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                siteDb.clearDiscoveryData();
            } catch (error) {
                db.close();
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Unknown error",
                };
            }
            db.close();

            // Best-effort: also wipe the on-disk Crawlee request queue so a
            // fresh `start` after a clear doesn't try to resume the old one.
            try {
                const crawleeDir = path.join(projectPath, ".raiken", "crawlee");
                await fs.rm(crawleeDir, { recursive: true, force: true });
            } catch {
                // non-fatal
            }

            discoveryRuntimeStore.set(projectPath, createEmptyDiscoveryState());
            pushDiscoveryEvent(projectPath, {
                type: "cleared",
                message: "Discovery data cleared",
            });

            return {
                success: true,
                message: "Discovery data cleared successfully",
                runtime: getDiscoveryState(projectPath),
            };
        }),

    /**
     * Pause a running discovery, preserving session state so the user can
     * later resume from where it stopped.
     */
    /**
     * User-initiated pause. Records a `manual` blocker so the dashboard's
     * BlockerPanel has something to render and the auto-resume logic in
     * `hydrateDiscoveryState` knows not to silently restart the crawl
     * (it only auto-resumes when every blocker is resolved, and a manual
     * pause stays unresolved until the user clicks Continue).
     */
    pauseDiscovery: t.procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const job = discoveryJobStore.get(projectPath);
            if (!job) {
                return {
                    success: false,
                    message: "No discovery job is running",
                    runtime: getDiscoveryState(projectPath),
                };
            }
            try {
                const state = getDiscoveryState(projectPath);
                const pauseUrl = state.currentUrl ?? null;
                await job.discovery.pause();
                // Stamp a manual blocker so the BlockerPanel renders this
                // pause as a distinct, user-initiated stop the user can
                // resolve with the same Continue/Skip/Ignore controls.
                try {
                    const db = new CodeGraphDB(projectPath);
                    try {
                        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                        siteDb.saveBlocker({
                            projectPath,
                            url: pauseUrl ?? "manual_pause",
                            category: "manual",
                            severity: "pause",
                            detectorId: "manual:user_pause",
                            detectedElements: null,
                            evidenceJson: JSON.stringify({
                                reason: "User clicked Pause from the dashboard",
                            }),
                            screenshotPath: null,
                            resolution: null,
                            resolvedVia: null,
                            resolvedAt: null,
                            storageStatePath: null,
                            discoveredAt: Date.now(),
                        });
                    } finally {
                        db.close();
                    }
                } catch {
                    // Persisting the marker is best-effort; the pause
                    // itself already happened above.
                }
                pushDiscoveryEvent(projectPath, {
                    type: "stopped",
                    message: "Discovery paused by user (resumable)",
                });
                patchDiscoveryState(projectPath, { phase: "paused" });
                return {
                    success: true,
                    message: "Discovery paused",
                    runtime: getDiscoveryState(projectPath),
                };
            } catch (error) {
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Failed to pause discovery",
                    runtime: getDiscoveryState(projectPath),
                };
            }
        }),

    /**
     * Drive-it-yourself browser handoff.
     *
     * Spawns a visible Chromium window pointed at `url` (defaulting to the
     * current blocker's URL), watches for the user to clear whatever's in
     * the way (login form, captcha, consent banner, "I'm 18+" gate, ...),
     * snapshots the resulting cookies + localStorage to
     * `.raiken/auth-state.json`, and marks any matching unresolved
     * blockers resolved with `resolution = "handoff"`. The next
     * `continueDiscovery` call (or auto-resume) picks up where the crawl
     * paused, this time with the new storage state injected.
     *
     * The actual browser logic lives in `manual-handoff.ts` so the CLI's
     * `raiken auth` command and this dashboard mutation share one
     * implementation.
     */
    requestBrowserHandoff: t.procedure
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url().optional(),
                blockerId: z.number().int().positive().optional(),
                category: z
                    .enum([
                        "auth_required",
                        "captcha",
                        "consent_wall",
                        "rate_limited",
                        "geo_blocked",
                        "interstitial",
                        "error_page",
                        "manual",
                        "unknown",
                    ])
                    .optional(),
                timeoutMs: z
                    .number()
                    .int()
                    .positive()
                    .max(30 * 60 * 1000)
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;

            if (handoffJobStore.has(projectPath)) {
                return {
                    success: false,
                    message: "A browser handoff is already in progress for this project.",
                    runtime: getDiscoveryState(projectPath),
                };
            }

            // Resolve a target URL: explicit > targeted blocker > the
            // current pause point > the latest unresolved blocker.
            let url = input.url ?? null;
            let blockerId = input.blockerId ?? null;
            let category = input.category;

            try {
                const db = new CodeGraphDB(projectPath);
                try {
                    const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
                    if (blockerId) {
                        const blocker = siteDb.getBlocker(blockerId);
                        if (blocker) {
                            url = url ?? blocker.url;
                            category = category ?? blocker.category;
                        }
                    } else {
                        const unresolved = siteDb.getUnresolvedBlockers();
                        if (unresolved.length > 0) {
                            const target = unresolved[0];
                            blockerId = target.id ?? null;
                            url = url ?? target.url;
                            category = category ?? target.category;
                        }
                    }
                } finally {
                    db.close();
                }
            } catch {
                // Best-effort lookup — fall back to whatever the caller passed.
            }

            if (!url) {
                const state = getDiscoveryState(projectPath);
                url = state.blockedAtUrl ?? state.currentUrl ?? null;
            }

            if (!url) {
                return {
                    success: false,
                    message:
                        "No URL to hand off to. Pass a `url` or wait until a blocker is detected.",
                    runtime: getDiscoveryState(projectPath),
                };
            }

            pushDiscoveryEvent(projectPath, {
                type: "warning",
                message: `Opening ${url} in a visible browser for manual handoff…`,
                data: { url, blockerId, category },
            });

            const run = runManualHandoff({
                projectPath,
                url,
                blockerId,
                category,
                timeoutMs: input.timeoutMs,
                // Honour `auth.storageStatePath` from raiken.config.json — the
                // handoff captures cookies that the next crawl needs to read
                // back via `resolveAuthStorageStatePath`. Pre-fix this defaulted
                // to `.raiken/auth-state.json` regardless of config, leaving
                // configured projects with stale auth state forever.
                storageStatePath: resolveAuthStorageStateDestination(projectPath),
                onProgress: (snapshot) => {
                    if (snapshot.reason) {
                        pushDiscoveryEvent(projectPath, {
                            type: "continued",
                            message: `Handoff finished (${snapshot.reason}): ${snapshot.cookies} cookies, ${snapshot.origins} origins captured.`,
                            data: { ...snapshot, blockerId },
                        });
                    }
                },
            });

            handoffJobStore.set(projectPath, run);

            try {
                const result = await run;
                return {
                    success: true,
                    message: `Captured storage state (${result.cookies} cookies, ${result.origins} origins) and resolved ${result.blockersResolved} blocker(s).`,
                    storageStatePath: result.storageStatePath,
                    blockersResolved: result.blockersResolved,
                    reason: result.reason,
                    runtime: getDiscoveryState(projectPath),
                };
            } catch (error) {
                pushDiscoveryEvent(projectPath, {
                    type: "error",
                    message: `Browser handoff failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                });
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Browser handoff failed",
                    runtime: getDiscoveryState(projectPath),
                };
            } finally {
                handoffJobStore.delete(projectPath);
            }
        }),

    /**
     * Abort a running discovery. Marks the session complete so it cannot be
     * resumed; keeps any pages/links already discovered.
     */
    abortDiscovery: t.procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const job = discoveryJobStore.get(projectPath);
            if (!job) {
                return {
                    success: false,
                    message: "No discovery job is running",
                    runtime: getDiscoveryState(projectPath),
                };
            }
            try {
                await job.discovery.abort();
                pushDiscoveryEvent(projectPath, {
                    type: "stopped",
                    message: "Discovery aborted by user",
                });
                patchDiscoveryState(projectPath, {
                    phase: "completed",
                    completionReason: "Stopped by user",
                    requiresAuth: false,
                    blockedAtUrl: null,
                });
                return {
                    success: true,
                    message: "Discovery aborted",
                    runtime: getDiscoveryState(projectPath),
                };
            } catch (error) {
                return {
                    success: false,
                    message: error instanceof Error ? error.message : "Failed to abort discovery",
                    runtime: getDiscoveryState(projectPath),
                };
            }
        }),

    /**
     * Dismiss a sticky error phase so the UI can return to idle without
     * having to start a fresh crawl or wipe data.
     */
    dismissDiscoveryError: t.procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = input.path || ctx.projectPath;
            const state = getDiscoveryState(projectPath);
            if (state.phase !== "error") {
                return {
                    success: false,
                    message: "Discovery is not in an error state",
                    runtime: state,
                };
            }
            const next = patchDiscoveryState(projectPath, {
                phase: "idle",
                lastError: null,
            });
            return {
                success: true,
                message: "Error dismissed",
                runtime: next,
            };
        }),

    // ============================================================================
    // Quality Tools — doctor / context / cover / trace / ci
    // ============================================================================

    runDoctor: t.procedure
        .input(
            z.object({
                testDirectory: z.string().optional(),
                extraDirectories: z.array(z.string()).optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            const testDirectory =
                input.testDirectory ?? (await loadConfiguredTestDirectory(ctx.projectPath));
            return scanTests({
                projectPath: ctx.projectPath,
                testDirectory,
                extraDirectories: input.extraDirectories,
            });
        }),

    writeContext: t.procedure
        .input(
            z.object({
                outputPath: z.string().optional(),
                maxRowsPerSection: z.number().int().positive().max(200).optional(),
                includeImpact: z.boolean().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const result = await writeProjectContext({
                projectPath: ctx.projectPath,
                outputPath: input.outputPath,
                maxRowsPerSection: input.maxRowsPerSection,
                includeImpact: input.includeImpact,
            });
            return {
                ...result,
                relativePath: path.relative(ctx.projectPath, result.outputPath),
            };
        }),

    runCover: t.procedure
        .input(
            z.object({
                target: z.string().min(1),
                ticketId: z.string().optional(),
                testDirectory: z.string().optional(),
                outputPath: z.string().optional(),
                dryRun: z.boolean().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const { integrationConfig, aiConfig } = await loadAiAndIntegrations(ctx.projectPath);
            const result = await runCover({
                projectPath: ctx.projectPath,
                target: input.target,
                ticketId: input.ticketId,
                testDirectory: input.testDirectory,
                outputPath: input.outputPath,
                dryRun: input.dryRun,
                integrations: integrationConfig,
                ai: aiConfig,
            });
            return {
                ...result,
                relativePath: path.relative(ctx.projectPath, result.outputPath),
            };
        }),

    queryTrace: t.procedure
        .input(
            z.object({
                trace: z.string().min(1),
                minConfidence: z.number().min(0).max(1).optional(),
                limit: z.number().int().positive().max(100).optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            return queryTrace({
                projectPath: ctx.projectPath,
                trace: input.trace,
                minConfidence: input.minConfidence,
                limit: input.limit,
            });
        }),

    runCi: t.procedure
        .input(
            z.object({
                base: z.string().optional(),
                head: z.string().optional(),
                staged: z.boolean().optional(),
                skipRun: z.boolean().optional(),
                confidenceThreshold: z.number().min(0).max(1).optional(),
                maxTests: z.number().int().positive().max(200).optional(),
                testTimeout: z.number().int().positive().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            // Dashboard usage is always impact-first: we don't spawn Playwright
            // from the server unless the caller opts in explicitly.
            const skipRun = input.skipRun ?? true;
            const result = await runCi({
                projectPath: ctx.projectPath,
                base: input.base,
                head: input.head,
                staged: input.staged,
                skipRun,
                confidenceThreshold: input.confidenceThreshold,
                maxTests: input.maxTests,
                testTimeout: input.testTimeout,
                // The dashboard doesn't need file reports.
                format: "json",
                outputDir: path.join(ctx.projectPath, ".raiken", "ci-dashboard"),
            });
            return {
                exitCode: result.exitCode,
                impact: result.impact,
                run: result.run,
            };
        }),
});

async function loadConfiguredTestDirectory(projectPath: string): Promise<string> {
    try {
        const raw = await fs.readFile(path.join(projectPath, "raiken.config.json"), "utf-8");
        const parsed = JSON.parse(raw) as { testDirectory?: unknown };
        if (typeof parsed.testDirectory === "string" && parsed.testDirectory.trim()) {
            return parsed.testDirectory;
        }
    } catch {
        // fall through to default
    }
    return "e2e";
}

async function loadAiAndIntegrations(projectPath: string): Promise<{
    integrationConfig?: Parameters<typeof runCover>[0]["integrations"];
    aiConfig: { apiKey?: string; model?: string; baseURL?: string };
}> {
    let integrationConfig: Parameters<typeof runCover>[0]["integrations"] | undefined;
    let aiConfig: { apiKey?: string; model?: string; baseURL?: string } = {
        apiKey: process.env["OPENROUTER_API_KEY"],
    };
    try {
        const raw = await fs.readFile(path.join(projectPath, "raiken.config.json"), "utf-8");
        const parsed = JSON.parse(raw) as {
            integrations?: unknown;
            ai?: { apiKey?: string; model?: string; baseURL?: string };
        };
        integrationConfig = parsed.integrations as Parameters<typeof runCover>[0]["integrations"];
        aiConfig = {
            apiKey: parsed.ai?.apiKey || process.env["OPENROUTER_API_KEY"],
            model: parsed.ai?.model,
            baseURL: parsed.ai?.baseURL,
        };
    } catch {
        // no config file — keep defaults
    }
    return { integrationConfig, aiConfig };
}

// Export the Type to be shared
export type AppRouter = typeof appRouter;
