import { loadDiscoveryConfig } from "../../config/load";
import { CodeGraphDB } from "../../database/db";
import {
    acquireProjectOperation,
    type ProjectOperationLease,
} from "../../operations/project-operation";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import { type ManualHandoffReason, runManualHandoff } from "../../site-discovery/manual-handoff";
import { getDiscoveryProjectRuntime } from "./registry";
import {
    discoveryJobStore,
    getDiscoveryState,
    handoffJobStore,
    patchDiscoveryState,
    pushDiscoveryEvent,
} from "./state";
import type {
    CancelBrowserHandoffResult,
    RequestBrowserHandoffInput,
    RequestBrowserHandoffResult,
} from "./types";

function describeUnpersistedHandoff(
    reason: ManualHandoffReason,
    errorMessage: string | undefined,
): string {
    switch (reason) {
        case "abort":
            return "Browser handoff cancelled.";
        case "error":
            return errorMessage ?? "Browser handoff failed.";
        case "timeout":
            return "Browser handoff timed out before login completed — auth state was not saved.";
        case "browser-closed":
            return "Browser closed before login completed — auth state was not saved.";
        default:
            return "Browser handoff finished without a confirmed login — auth state was not saved.";
    }
}

export async function requestBrowserHandoff(
    projectPath: string,
    input: RequestBrowserHandoffInput,
    resolveStorageStatePath: (projectPath: string) => string,
): Promise<RequestBrowserHandoffResult> {
    if (handoffJobStore.has(projectPath)) {
        return {
            success: false,
            message: "A browser handoff is already in progress for this project.",
            runtime: getDiscoveryState(projectPath),
        };
    }

    let url = input.url ?? null;
    let blockerId = input.blockerId ?? null;
    let category = input.category;

    try {
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(
                db.getRawDatabase(),
                projectPath,
                loadDiscoveryConfig(projectPath).preserveQueryParams,
            );
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
        // best-effort lookup
    }

    if (!url) {
        const state = getDiscoveryState(projectPath);
        url = state.blockedAtUrl ?? state.currentUrl ?? null;
    }

    if (!url) {
        return {
            success: false,
            message: "No URL to hand off to. Pass a `url` or wait until a blocker is detected.",
            runtime: getDiscoveryState(projectPath),
        };
    }

    pushDiscoveryEvent(projectPath, {
        type: "warning",
        message: `Opening ${url} in a visible browser for manual handoff…`,
        data: { url, blockerId, category },
    });

    let operation: ProjectOperationLease;
    try {
        operation = await acquireProjectOperation(projectPath, "browser");
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : "Project is busy.",
            runtime: getDiscoveryState(projectPath),
        };
    }

    const runtime = getDiscoveryProjectRuntime(projectPath);
    const abortController = new AbortController();
    runtime.setHandoffAbort(abortController);

    const run = runManualHandoff({
        projectPath,
        url,
        blockerId,
        category,
        timeoutMs: input.timeoutMs,
        signal: abortController.signal,
        storageStatePath: resolveStorageStatePath(projectPath),
        onProgress: (snapshot) => {
            if (!snapshot.reason) return;
            const saved = snapshot.reason === "auto" || snapshot.reason === "manual";
            const hasIssue =
                !saved || Boolean(snapshot.blockerResolutionWarning || snapshot.errorMessage);
            pushDiscoveryEvent(projectPath, {
                type: hasIssue ? "warning" : "continued",
                message: snapshot.blockerResolutionWarning
                    ? `Handoff saved auth state (${snapshot.reason}), but blocker resolution failed: ${snapshot.blockerResolutionWarning}`
                    : snapshot.errorMessage
                      ? `Handoff failed (${snapshot.reason}): ${snapshot.errorMessage}`
                      : saved
                        ? `Handoff finished (${snapshot.reason}): ${snapshot.cookies} cookies, ${snapshot.origins} origins captured.`
                        : describeUnpersistedHandoff(snapshot.reason, snapshot.errorMessage),
                data: { ...snapshot, blockerId },
            });
        },
    });

    handoffJobStore.set(projectPath, run);

    try {
        const result = await run;
        if (result.blockerResolutionWarning) {
            pushDiscoveryEvent(projectPath, {
                type: "warning",
                message: result.blockerResolutionWarning,
                data: {
                    blockerId,
                    storageStatePath: result.storageStatePath,
                    blockersResolved: result.blockersResolved,
                },
            });
        }
        // Anything short of a confirmed login leaves `auth-state.json` alone,
        // so the crawl must stay blocked rather than resume unauthenticated.
        if (!result.persisted) {
            return {
                success: false,
                message: describeUnpersistedHandoff(result.reason, result.errorMessage),
                storageStatePath: result.storageStatePath,
                blockersResolved: result.blockersResolved,
                reason: result.reason,
                blockerResolutionWarning: result.blockerResolutionWarning,
                errorMessage: result.errorMessage,
                runtime: getDiscoveryState(projectPath),
            };
        }
        const resolvedSuffix =
            result.blockerResolutionWarning && result.blockersResolved === 0
                ? " Blockers were not cleared — see warning."
                : ` and resolved ${result.blockersResolved} blocker(s).`;
        return {
            success: true,
            message: `Captured storage state (${result.cookies} cookies, ${result.origins} origins)${resolvedSuffix}`,
            storageStatePath: result.storageStatePath,
            blockersResolved: result.blockersResolved,
            reason: result.reason,
            blockerResolutionWarning: result.blockerResolutionWarning,
            errorMessage: result.errorMessage,
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
        runtime.clearHandoffAbort();
        await operation.release();
    }
}

export function cancelBrowserHandoff(projectPath: string): CancelBrowserHandoffResult {
    const runtime = getDiscoveryProjectRuntime(projectPath);
    const cancelled = runtime.cancelHandoff();
    if (!cancelled) {
        return {
            success: false,
            message: "No browser handoff is in progress for this project.",
            runtime: getDiscoveryState(projectPath),
        };
    }
    pushDiscoveryEvent(projectPath, {
        type: "warning",
        message: "Browser handoff cancelled.",
    });
    return {
        success: true,
        message: "Browser handoff cancelled.",
        runtime: getDiscoveryState(projectPath),
    };
}

/** Abort an active handoff during clear — mirrors legacy clearData behavior. */
export async function abortActiveHandoffForClear(projectPath: string): Promise<void> {
    const runtime = getDiscoveryProjectRuntime(projectPath);
    if (runtime.hasHandoffAbort) {
        runtime.cancelHandoff();
        runtime.clearHandoffAbort();
        const pendingHandoff = handoffJobStore.get(projectPath);
        if (pendingHandoff) {
            await Promise.resolve(pendingHandoff).catch(() => undefined);
            handoffJobStore.delete(projectPath);
        }
    }
}

/** Abort a running discovery job during clear. */
export async function abortRunningJobForClear(projectPath: string): Promise<void> {
    const runtime = getDiscoveryProjectRuntime(projectPath);
    const runningJob = discoveryJobStore.get(projectPath);
    if (!runningJob) return;

    runtime.abortInFlight = true;
    patchDiscoveryState(projectPath, {
        phase: "running",
        completionReason: "Stopping…",
    });
    try {
        await runningJob.discovery.abort();
        await runningJob.promise.catch(() => undefined);
    } catch {
        try {
            await runningJob.discovery.close();
        } catch {
            // ignore
        }
        await runningJob.promise.catch(() => undefined);
    } finally {
        discoveryJobStore.delete(projectPath);
        runtime.abortInFlight = false;
    }
}
