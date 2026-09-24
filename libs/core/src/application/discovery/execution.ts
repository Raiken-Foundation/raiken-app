import { randomUUID } from "node:crypto";
import { conflictError, internalError } from "../../errors";
import { beginOperationScope, mergeCorrelationContext, obs } from "../../observability";
import { RunTraceRecorder } from "../../run-traces";
import type { SiteDiscovery } from "../../site-discovery/crawler";
import {
    createSiteDiscovery,
    resolveSiteDiscoveryOptions,
    type SiteDiscoveryOverrides,
} from "../../site-discovery/discovery-config";
import { acquireDiscoveryLock } from "../../site-discovery/project-lock";
import {
    attachBackgroundStateListeners,
    attachDiscoveryRuntimeListeners,
    attachUxListeners,
} from "./listeners";
import { getDiscoveryProjectRuntime } from "./registry";
import { discoveryJobStore, patchDiscoveryState, pushDiscoveryEvent } from "./state";
import { hydrateDiscoveryStateCore } from "./state-hydrator";
import type {
    BackgroundDiscoverState,
    DiscoveryExecutionKind,
    DiscoveryLaunchInput,
    DiscoveryLaunchResult,
    DiscoveryUxCallbacks,
    RunForegroundInput,
    StartDiscoveryJobOptions,
} from "./types";

function assertDiscoveryStartAllowed(projectPath: string): void {
    const runtime = getDiscoveryProjectRuntime(projectPath);
    if (discoveryJobStore.has(projectPath) || runtime.abortInFlight) {
        throw conflictError("Discovery is already running for this project", {
            code: "DISCOVERY_ALREADY_RUNNING",
        });
    }
}

export async function launchDiscoveryExecution(
    projectPath: string,
    input: DiscoveryLaunchInput,
    kind: DiscoveryExecutionKind,
    ux?: DiscoveryUxCallbacks,
): Promise<DiscoveryLaunchResult> {
    assertDiscoveryStartAllowed(projectPath);

    const runtime = getDiscoveryProjectRuntime(projectPath);
    const discoveryLock = await acquireDiscoveryLock(projectPath);
    const operationId = `discovery-${randomUUID()}`;

    let backgroundState: Exclude<BackgroundDiscoverState, { status: "idle" }> | undefined;
    let discovery: SiteDiscovery | undefined;

    try {
        return beginOperationScope({ operationId, projectPath }, () => {
            mergeCorrelationContext({ operationId, projectPath });
            const trace = RunTraceRecorder.forOperational(projectPath, "discovery", {
                operationId,
            });
            const discoveryStartedAt = Date.now();
            obs.info("discovery.run.started", { operationId, meta: { kind } });

            const resolveStorageState = input.resolveStorageState ?? true;
            const resolved = resolveSiteDiscoveryOptions({
                projectPath,
                startUrl: input.startUrl,
                preferSessionLimits: input.preferSessionLimits,
                session: input.session,
                overrides: input.overrides,
                resolveStorageState,
            });

            const discoveryOverrides: SiteDiscoveryOverrides = {
                ...input.overrides,
                continueSession: input.overrides?.continueSession,
                purgeQueueOnResume: input.purgeQueueOnResume ?? input.overrides?.purgeQueueOnResume,
            };
            if (input.storageStatePath !== undefined) {
                discoveryOverrides.storageStatePath = input.storageStatePath;
            }

            discovery = createSiteDiscovery(
                {
                    projectPath,
                    startUrl: input.startUrl,
                    preferSessionLimits: input.preferSessionLimits,
                    session: input.session,
                    overrides: discoveryOverrides,
                    resolveStorageState,
                },
                discoveryLock,
            );

            attachDiscoveryRuntimeListeners(projectPath, discovery);
            attachUxListeners(discovery, ux);
            discovery.on("session_started", (event: { data?: { sessionId?: number } }) => {
                const sessionId = event.data?.sessionId;
                if (sessionId != null) {
                    mergeCorrelationContext({ discoverySessionId: String(sessionId) });
                }
            });

            if (kind === "background") {
                backgroundState = {
                    status: "running",
                    startUrl: input.startUrl || "(resume)",
                    pages: 0,
                    links: 0,
                    maxPages: resolved.maxPages ?? 100,
                    startedAt: Date.now(),
                };
                attachBackgroundStateListeners(discovery, backgroundState, ux);
            }

            const now = new Date().toISOString();
            patchDiscoveryState(projectPath, {
                phase: "running",
                startedAt: now,
                updatedAt: now,
                currentUrl: input.startUrl || resolved.startUrl,
                currentDepth: 0,
                lastError: null,
                requiresAuth: false,
                blockedAtUrl: null,
                maxPages: resolved.maxPages ?? null,
                maxDepth: resolved.maxDepth ?? null,
                completionReason: null,
            });
            pushDiscoveryEvent(projectPath, {
                type: input.overrides?.continueSession ? "continued" : "started",
                message: input.overrides?.continueSession
                    ? `Resumed discovery at ${input.startUrl || resolved.startUrl}`
                    : `Started discovery at ${input.startUrl}`,
            });

            const promise = (async () => {
                const crawler = discovery;
                if (!crawler) return;
                try {
                    await crawler.start();
                    if (kind === "background" && backgroundState?.status === "running") {
                        try {
                            const stats = crawler.getStats();
                            backgroundState.pages = stats.pagesDiscovered;
                            backgroundState.links = stats.linksFound;
                            backgroundState.currentUrl =
                                stats.currentUrl || backgroundState.currentUrl;
                        } catch {
                            /* ignore */
                        }
                        backgroundState.status = "completed";
                    }
                    await hydrateDiscoveryStateCore(projectPath, startDiscoveryJob);
                    trace?.end("completed");
                    obs.duration("discovery.run.completed", discoveryStartedAt, {
                        operationId,
                        status: "completed",
                    });
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : "Discovery failed unexpectedly";
                    trace?.end("error", message);
                    obs.duration("discovery.run.completed", discoveryStartedAt, {
                        level: "error",
                        operationId,
                        status: "error",
                        message,
                    });
                    if (kind === "background" && backgroundState) {
                        if (
                            backgroundState.status === "running" ||
                            backgroundState.status === "paused"
                        ) {
                            backgroundState.status = "failed";
                            backgroundState.error = message;
                        }
                    } else {
                        patchDiscoveryState(projectPath, {
                            phase: "error",
                            lastError: message,
                            requiresAuth: false,
                        });
                        pushDiscoveryEvent(projectPath, { type: "error", message });
                    }
                    if (kind === "blocking") {
                        throw error;
                    }
                } finally {
                    try {
                        if (discovery) await discovery.close();
                    } catch {
                        // Already logged inside SiteDiscovery.close via warning event.
                    } finally {
                        discoveryJobStore.delete(projectPath);
                        await discoveryLock.release();
                        if (kind === "background") {
                            setTimeout(() => {
                                const active = runtime.background;
                                if (active?.done === promise) {
                                    runtime.background = undefined;
                                }
                            }, 30_000).unref();
                        }
                    }
                }
            })();

            discoveryJobStore.set(projectPath, { discovery, promise });

            if (kind === "background" && backgroundState) {
                runtime.background = { state: backgroundState, done: promise };
                return {
                    promise,
                    background: { state: backgroundState, done: promise },
                };
            }

            return { promise };
        });
    } catch (error) {
        if (discovery) {
            try {
                await discovery.close();
            } catch {
                /* ignore */
            }
            discoveryJobStore.delete(projectPath);
        }
        await discoveryLock.release().catch(() => undefined);
        if (backgroundState) {
            runtime.background = undefined;
        }
        throw error;
    }
}

export async function startDiscoveryJob(
    projectPath: string,
    options: StartDiscoveryJobOptions,
): Promise<void> {
    const { promise } = await launchDiscoveryExecution(
        projectPath,
        {
            startUrl: options.startUrl,
            overrides: {
                maxPages: options.maxPages,
                maxDepth: options.maxDepth,
                timeout: options.timeout,
                skipAuth: options.skipAuth,
                excludePatterns: options.excludePatterns,
                continueSession: options.continueSession,
                purgeQueueOnResume: options.purgeQueueOnResume,
            },
        },
        "detached",
    );
    void promise.catch(() => {
        /* surfaced via runtime state / timeline */
    });
}

export async function executeBlockingDiscovery(
    projectPath: string,
    input: RunForegroundInput,
    ux?: DiscoveryUxCallbacks,
): Promise<void> {
    const { promise } = await launchDiscoveryExecution(projectPath, input, "blocking", ux);
    await promise;
}

export async function startBackgroundDiscoveryJob(
    projectPath: string,
    input: RunForegroundInput,
    ux?: DiscoveryUxCallbacks,
): Promise<{
    state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
    done: Promise<void>;
}> {
    const launched = await launchDiscoveryExecution(projectPath, input, "background", ux);
    if (!launched.background) {
        throw internalError("Background discovery failed to initialize.");
    }
    return launched.background;
}
