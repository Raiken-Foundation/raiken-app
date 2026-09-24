import { resolveUsableAuthStorageStatePath } from "../../config/auth-state";
import { getDiscoveryQueryService } from "../discovery-query-cache";
import { getDiscoveryProjectRuntime } from "./registry";
import {
    discoveryJobStore,
    getDiscoveryState,
    patchDiscoveryState,
    pushDiscoveryEvent,
    toDiscoveryPhase,
} from "./state";
import type { DiscoveryRuntimeState, StartDiscoveryJobOptions } from "./types";

export type ResumeDiscovery = (
    projectPath: string,
    options: StartDiscoveryJobOptions,
) => Promise<void>;

/**
 * Refresh the in-memory read model from persisted discovery state.
 *
 * The resume callback is injected so this leaf module never imports the
 * execution orchestrator. Callers that only need a post-run refresh may omit
 * it; interactive hydration supplies it to retain automatic blocker resume.
 */
export async function hydrateDiscoveryStateCore(
    projectPath: string,
    resumeDiscovery?: ResumeDiscovery,
): Promise<DiscoveryRuntimeState> {
    const current = getDiscoveryState(projectPath);
    const queryService = getDiscoveryQueryService(projectPath);
    const runtime = getDiscoveryProjectRuntime(projectPath);

    try {
        // "Running" is only believable while a job is actually in flight.
        // A leftover in-memory "running" phase (e.g. a drained page event
        // landing after the job ended, or a server restart mid-run) used to
        // short-circuit BOTH the stale-session sweep and the phase
        // re-derivation, cementing a phantom "Running" badge on first load.
        const jobInFlight = discoveryJobStore.has(projectPath);
        if (!jobInFlight) {
            const recovered = queryService.recoverStaleSessions();
            if (recovered > 0) {
                console.log(`Recovered ${recovered} stale discovery session(s) for ${projectPath}`);
            }
        }

        const stats = queryService.getStats();
        const session = queryService.getLatestSession();
        const unresolvedBlockers = queryService.getUnresolvedBlockers();
        const hasUnresolvedBlockers = unresolvedBlockers.length > 0;
        const hasUnresolvedAuth = unresolvedBlockers.some((b) => b.category === "auth_required");
        const requiresAuth =
            session?.status === "paused" && Boolean(session.blockedAtUrl) && hasUnresolvedAuth;

        const next = patchDiscoveryState(projectPath, {
            phase:
                current.phase === "running" && jobInFlight
                    ? "running"
                    : toDiscoveryPhase(session?.status),
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

        const wasWaitingForBlocker =
            current.requiresAuth ||
            current.phase === "paused" ||
            (current.authBlockersFound ?? 0) > 0;
        const everyBlockerResolved = unresolvedBlockers.length === 0;
        if (
            resumeDiscovery &&
            wasWaitingForBlocker &&
            everyBlockerResolved &&
            session?.status === "paused" &&
            !discoveryJobStore.has(projectPath) &&
            !runtime.autoResumeInFlight
        ) {
            runtime.autoResumeInFlight = true;
            const resumeSession = session;
            queueMicrotask(() => {
                void (async () => {
                    try {
                        const hasFreshAuthState =
                            resolveUsableAuthStorageStatePath(projectPath) !== null;
                        const purgeQueueOnResume = hasFreshAuthState;
                        const resumeUrl = purgeQueueOnResume
                            ? resumeSession.startUrl
                            : resumeSession.blockedAtUrl || resumeSession.startUrl;
                        if (!resumeUrl) return;
                        console.log(
                            `Auto-resuming discovery for ${projectPath} after blockers cleared (purge=${purgeQueueOnResume}, url=${resumeUrl})`,
                        );
                        pushDiscoveryEvent(projectPath, {
                            type: "continued",
                            message: purgeQueueOnResume
                                ? `Blockers cleared with new auth state — re-crawling from ${resumeUrl}`
                                : "Blockers cleared — auto-resuming discovery",
                        });
                        await resumeDiscovery(projectPath, {
                            startUrl: resumeUrl,
                            maxPages: resumeSession.maxPages ?? undefined,
                            maxDepth: resumeSession.maxDepth ?? undefined,
                            continueSession: true,
                            purgeQueueOnResume,
                        });
                    } catch (err) {
                        console.warn(
                            `Auto-resume failed for ${projectPath}:`,
                            err instanceof Error ? err.message : err,
                        );
                    } finally {
                        runtime.autoResumeInFlight = false;
                    }
                })();
            });
        }

        return next;
    } catch {
        return current;
    }
}
