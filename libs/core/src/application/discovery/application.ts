import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadDiscoveryConfig } from "../../config/load";
import { CodeGraphDB } from "../../database/db";
import { conflictError } from "../../errors";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import type { SiteDiscoveryOverrides } from "../../site-discovery/discovery-config";
import { acquireDiscoveryLock, type DiscoveryLockHandle } from "../../site-discovery/project-lock";
import type { ProjectApplicationContext } from "../context";
import { canonicalProjectPath } from "../discovery-query-cache";
import { continueDiscoverySession, resolveAuthBlockersWithState } from "./auth-resume";
import {
    executeBlockingDiscovery,
    startBackgroundDiscoveryJob,
    startDiscoveryJob,
} from "./execution";
import {
    abortActiveHandoffForClear,
    abortRunningJobForClear,
    cancelBrowserHandoff,
    requestBrowserHandoff,
} from "./handoff";
import { getResumeContext, hydrateDiscoveryState, invalidateDiscoveryQuery } from "./hydration";
import { DiscoveryReadModel } from "./query-facade";
import {
    disposeDiscoveryProjectRuntime,
    getDiscoveryProjectRuntime,
    isBrowserHandoffInProgress,
    resetDiscoveryProjectRegistryForTests,
} from "./registry";
import {
    discoveryCoordinator,
    discoveryJobStore,
    getDiscoveryState,
    patchDiscoveryState,
    pushDiscoveryEvent,
} from "./state";
import type {
    BackgroundDiscoverState,
    ContinueDiscoveryInput,
    DiscoveryRuntimeState,
    DiscoveryUxCallbacks,
    HydratedDiscoveryRuntime,
    RequestBrowserHandoffInput,
    RunForegroundInput,
} from "./types";

/**
 * Project-scoped discovery orchestration: job lifecycle, hydration, auto-resume,
 * query caching, and handoff coordination.
 */
export class DiscoveryApplication implements ProjectApplicationContext {
    readonly projectPath: string;
    private readonly readModel: DiscoveryReadModel;

    constructor(projectPath: string) {
        this.projectPath = canonicalProjectPath(projectPath);
        this.readModel = new DiscoveryReadModel(this.projectPath);
        getDiscoveryProjectRuntime(this.projectPath);
    }

    getRuntimeState(): DiscoveryRuntimeState {
        return getDiscoveryState(this.projectPath);
    }

    async hydrateRuntime(): Promise<HydratedDiscoveryRuntime> {
        const hydrated = await hydrateDiscoveryState(this.projectPath);
        return {
            ...hydrated,
            isRunningInProcess: discoveryJobStore.has(this.projectPath),
            isBrowserHandoffInProgress: isBrowserHandoffInProgress(this.projectPath),
        };
    }

    getTimeline(limit: number): {
        events: import("../../site-discovery/coordinator").DiscoveryRuntimeEvent[];
        total: number;
    } {
        const state = getDiscoveryState(this.projectPath);
        return {
            events: state.lastEvents.slice(-limit).reverse(),
            total: state.lastEvents.length,
        };
    }

    dispose(): void {
        invalidateDiscoveryQuery(this.projectPath);
        const runtime = getDiscoveryProjectRuntime(this.projectPath);
        runtime.background = undefined;
        disposeDiscoveryProjectRuntime(this.projectPath);
    }

    getStats() {
        return this.readModel.getStats();
    }

    getSessionView() {
        return this.readModel.getSessionView();
    }

    getAuthAssist() {
        return this.readModel.getAuthAssist();
    }

    listDiscoveredPages(input: { limit?: number; offset?: number }) {
        return this.readModel.listDiscoveredPages(input);
    }

    getDiscoveredPageSnapshot(url: string) {
        return this.readModel.getDiscoveredPageSnapshot(url);
    }

    getAuthBlockers() {
        return this.readModel.getAuthBlockers();
    }

    getVerifiedLinks(limit: number) {
        return this.readModel.getVerifiedLinks(limit);
    }

    async runForeground(input: RunForegroundInput, ux?: DiscoveryUxCallbacks): Promise<void> {
        await executeBlockingDiscovery(this.projectPath, input, ux);
    }

    async runContinueForeground(
        input: Omit<RunForegroundInput, "startUrl"> & { startUrl?: string },
        ux?: DiscoveryUxCallbacks,
    ): Promise<void> {
        const { session, pendingAuthBlockers } = await getResumeContext(this.projectPath);
        const storageStatePath = input.storageStatePath;
        let purgeQueueOnResume = input.purgeQueueOnResume ?? false;

        if (
            input.resolvePendingAuthWithState &&
            storageStatePath &&
            pendingAuthBlockers.length > 0
        ) {
            await resolveAuthBlockersWithState(
                this.projectPath,
                pendingAuthBlockers,
                storageStatePath,
            );
            purgeQueueOnResume = true;
        }

        const overrides: SiteDiscoveryOverrides = {
            ...input.overrides,
            continueSession: true,
            purgeQueueOnResume,
        };
        if (storageStatePath !== undefined) {
            overrides.storageStatePath = storageStatePath;
        }

        await executeBlockingDiscovery(
            this.projectPath,
            {
                startUrl: input.startUrl ?? "",
                preferSessionLimits: true,
                session,
                resolveStorageState: input.resolveStorageState,
                storageStatePath,
                purgeQueueOnResume,
                overrides,
            },
            ux,
        );
    }

    async startBackground(
        input: Omit<RunForegroundInput, "startUrl"> & { url: string },
        ux?: DiscoveryUxCallbacks,
    ): Promise<{
        state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
        done: Promise<void>;
    }> {
        const runtime = getDiscoveryProjectRuntime(this.projectPath);
        if (runtime.abortInFlight) {
            throw conflictError(
                "Discovery is stopping — wait for it to finish before starting again.",
                { code: "DISCOVERY_ALREADY_RUNNING" },
            );
        }
        const active = runtime.background;
        if (active && (active.state.status === "running" || active.state.status === "paused")) {
            throw conflictError(
                "Discovery already in progress. Wait for it to finish, or check /discover status.",
                { code: "DISCOVERY_ALREADY_RUNNING" },
            );
        }
        return startBackgroundDiscoveryJob(
            this.projectPath,
            {
                startUrl: input.url,
                overrides: input.overrides,
                resolveStorageState: input.resolveStorageState,
            },
            ux,
        );
    }

    async continueBackground(
        input: { skipAuth?: boolean } = {},
        ux?: DiscoveryUxCallbacks,
    ): Promise<{
        state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
        done: Promise<void>;
    }> {
        const runtime = getDiscoveryProjectRuntime(this.projectPath);
        if (runtime.background?.state.status === "running") {
            throw conflictError("Discovery is already running.", {
                code: "DISCOVERY_ALREADY_RUNNING",
            });
        }
        return startBackgroundDiscoveryJob(
            this.projectPath,
            {
                startUrl: "",
                overrides: { skipAuth: input.skipAuth, continueSession: true },
            },
            ux,
        );
    }

    getBackgroundStatus(): BackgroundDiscoverState {
        const active = getDiscoveryProjectRuntime(this.projectPath).background;
        if (!active) return { status: "idle" };
        return { ...active.state };
    }

    isBackgroundRunning(): boolean {
        return getDiscoveryProjectRuntime(this.projectPath).background?.state.status === "running";
    }

    async start(input: {
        url: string;
        maxPages?: number;
        maxDepth?: number;
        timeout?: number;
        skipAuth?: boolean;
        excludePatterns?: string[];
    }) {
        const runtime = getDiscoveryState(this.projectPath);
        const projectRuntime = getDiscoveryProjectRuntime(this.projectPath);
        if (projectRuntime.abortInFlight) {
            return {
                success: false,
                message: "Discovery is stopping — wait for it to finish before starting again",
                runtime,
            };
        }
        if (runtime.phase === "running" && discoveryJobStore.has(this.projectPath)) {
            return {
                success: false,
                message: "Discovery is already running",
                runtime,
            };
        }
        if (runtime.phase === "paused") {
            return {
                success: false,
                message:
                    "Discovery is paused. Resolve the blocker and Continue, or Clear before starting a new crawl.",
                runtime,
            };
        }

        try {
            await startDiscoveryJob(this.projectPath, {
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
                runtime: getDiscoveryState(this.projectPath),
            };
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to start discovery",
                runtime: getDiscoveryState(this.projectPath),
            };
        }
    }

    async continue(input: ContinueDiscoveryInput = {}) {
        return continueDiscoverySession(this.projectPath, input);
    }

    async pause() {
        const projectPath = this.projectPath;
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
            await job.discovery.pause({ blockedAtUrl: pauseUrl });
            try {
                const db = new CodeGraphDB(projectPath);
                try {
                    const siteDb = new SiteKnowledgeDB(
                        db.getRawDatabase(),
                        projectPath,
                        loadDiscoveryConfig(projectPath).preserveQueryParams,
                    );
                    if (pauseUrl) {
                        const session = siteDb.getActiveSession();
                        if (session?.id) {
                            siteDb.updateSession(session.id, {
                                status: "paused",
                                blockedAtUrl: pauseUrl,
                            });
                        }
                    }
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
                // best-effort marker
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
    }

    async abort() {
        const projectPath = this.projectPath;
        const job = discoveryJobStore.get(projectPath);
        if (!job) {
            return {
                success: false,
                message: "No discovery job is running",
                runtime: getDiscoveryState(projectPath),
            };
        }
        const runtime = getDiscoveryProjectRuntime(projectPath);
        runtime.abortInFlight = true;
        patchDiscoveryState(projectPath, {
            phase: "running",
            lastError: null,
            completionReason: "Stopping…",
        });
        try {
            await job.discovery.abort();
            await job.promise.catch(() => undefined);
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
        } finally {
            discoveryJobStore.delete(projectPath);
            runtime.abortInFlight = false;
        }
    }

    dismissError() {
        const state = getDiscoveryState(this.projectPath);
        if (state.phase !== "error") {
            return {
                success: false,
                message: "Discovery is not in an error state",
                runtime: state,
            };
        }
        const next = patchDiscoveryState(this.projectPath, {
            phase: "idle",
            lastError: null,
        });
        return { success: true, message: "Error dismissed", runtime: next };
    }

    async clearData() {
        const projectPath = this.projectPath;
        await abortActiveHandoffForClear(projectPath);
        await abortRunningJobForClear(projectPath);

        let discoveryLock: DiscoveryLockHandle;
        try {
            discoveryLock = await acquireDiscoveryLock(projectPath);
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
                runtime: getDiscoveryState(projectPath),
            };
        }

        try {
            getDiscoveryProjectRuntime(projectPath).background = undefined;
            invalidateDiscoveryQuery(projectPath);

            const db = new CodeGraphDB(projectPath);
            try {
                const siteDb = new SiteKnowledgeDB(
                    db.getRawDatabase(),
                    projectPath,
                    loadDiscoveryConfig(projectPath).preserveQueryParams,
                );
                siteDb.clearDiscoveryData();
            } finally {
                db.close();
            }

            const crawleeDir = path.join(projectPath, ".raiken", "crawlee");
            await fs.rm(crawleeDir, { recursive: true, force: true }).catch(() => undefined);

            discoveryCoordinator.resetState(projectPath);
            pushDiscoveryEvent(projectPath, {
                type: "cleared",
                message: "Discovery data cleared",
            });

            return {
                success: true,
                message: "Discovery data cleared successfully",
                runtime: getDiscoveryState(projectPath),
            };
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
                runtime: getDiscoveryState(projectPath),
            };
        } finally {
            await discoveryLock.release().catch(() => undefined);
        }
    }

    cancelBrowserHandoff() {
        return cancelBrowserHandoff(this.projectPath);
    }

    requestBrowserHandoff(
        input: RequestBrowserHandoffInput,
        resolveStorageStatePath: (projectPath: string) => string,
    ) {
        return requestBrowserHandoff(this.projectPath, input, resolveStorageStatePath);
    }
}

export function __resetBackgroundDiscoverForTests(): void {
    resetDiscoveryProjectRegistryForTests();
}

export { resolveAuthBlockersWithState } from "./auth-resume";
export { getResumeContext, hydrateDiscoveryState } from "./hydration";
