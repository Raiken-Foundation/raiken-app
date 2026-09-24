import {
    describeAuthStateProblem,
    inspectAuthState,
    resolveUsableAuthStorageStatePath,
} from "../../config/auth-state";
import { loadDiscoveryConfig } from "../../config/load";
import { resolvePathWithinProject } from "../../config/store";
import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import type { DiscoveryBlocker } from "../../site-discovery/types";
import { startDiscoveryJob } from "./execution";
import { discoveryJobStore, getDiscoveryState } from "./state";
import type { ContinueDiscoveryInput, DiscoveryCommandResult } from "./types";

export async function resolveAuthBlockersWithState(
    projectPath: string,
    blockers: DiscoveryBlocker[],
    storageStatePath: string,
): Promise<void> {
    if (blockers.length === 0) return;
    const db = new CodeGraphDB(projectPath);
    try {
        const siteDb = new SiteKnowledgeDB(
            db.getRawDatabase(),
            projectPath,
            loadDiscoveryConfig(projectPath).preserveQueryParams,
        );
        for (const blocker of blockers) {
            if (blocker.id) {
                siteDb.markBlockerResolved(blocker.id, {
                    resolution: "provide_state",
                    resolvedVia: "cli_continue",
                    storageStatePath,
                });
            }
        }
    } finally {
        db.close();
    }
}

export async function continueDiscoverySession(
    projectPath: string,
    input: ContinueDiscoveryInput = {},
): Promise<DiscoveryCommandResult> {
    if (discoveryJobStore.has(projectPath)) {
        return {
            success: false,
            message: "Discovery is already running",
            runtime: getDiscoveryState(projectPath),
        };
    }

    const db = new CodeGraphDB(projectPath);
    try {
        const siteDb = new SiteKnowledgeDB(
            db.getRawDatabase(),
            projectPath,
            loadDiscoveryConfig(projectPath).preserveQueryParams,
        );
        const activeSession = siteDb.getActiveSession();

        if (!activeSession || activeSession.status !== "paused") {
            return {
                success: false,
                message: "No paused discovery session found",
                runtime: getDiscoveryState(projectPath),
            };
        }

        const resolution = input.resolution ?? "clear";
        const targetBlocker = input.blockerId ? siteDb.getBlocker(input.blockerId) : null;
        const activeSessionId = activeSession.id;
        if (!activeSessionId) {
            return {
                success: false,
                message: "Paused discovery session is missing an id",
                runtime: getDiscoveryState(projectPath),
            };
        }

        let resumeStartUrl = activeSession.blockedAtUrl || activeSession.startUrl;
        let purgeQueueOnResume = false;

        if (resolution === "skip") {
            const skipUrl = targetBlocker?.url ?? activeSession.blockedAtUrl ?? null;
            if (skipUrl) {
                siteDb.updateSession(activeSessionId, {
                    skippedUrlsJson: JSON.stringify(
                        Array.from(
                            new Set([
                                ...(activeSession.skippedUrlsJson
                                    ? (JSON.parse(activeSession.skippedUrlsJson) as string[])
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
            resumeStartUrl = activeSession.startUrl;
        } else if (resolution === "ignore_category") {
            const category = input.category ?? targetBlocker?.category ?? "auth_required";
            siteDb.updateSession(activeSessionId, {
                ignoredCategoriesJson: JSON.stringify(
                    Array.from(
                        new Set([
                            ...(activeSession.ignoredCategoriesJson
                                ? (JSON.parse(activeSession.ignoredCategoriesJson) as string[])
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
            const statePath = input.storageStatePath
                ? resolvePathWithinProject(projectPath, input.storageStatePath)
                : resolveUsableAuthStorageStatePath(projectPath);
            if (!statePath) {
                throw new Error(
                    "No usable auth state was provided. Run `raiken auth` and try again.",
                );
            }
            const inspection = inspectAuthState(statePath);
            if (inspection.status !== "valid") {
                throw new Error(
                    describeAuthStateProblem(inspection) ??
                        "The provided auth state is not usable.",
                );
            }
            if (input.blockerId) {
                siteDb.markBlockerResolved(input.blockerId, {
                    resolution: "provide_state",
                    resolvedVia: "dashboard",
                    storageStatePath: statePath,
                });
            }
            const all = siteDb.getUnresolvedBlockers();
            for (const b of all) {
                if (b.category === "auth_required" && b.id) {
                    siteDb.markBlockerResolved(b.id, {
                        resolution: "provide_state",
                        resolvedVia: "dashboard",
                        storageStatePath: statePath,
                    });
                }
            }
            purgeQueueOnResume = true;
            resumeStartUrl = activeSession.startUrl;
        } else {
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

            const targetIsAuth =
                targetBlocker?.category === "auth_required" || input.category === "auth_required";
            if (targetIsAuth && resolveUsableAuthStorageStatePath(projectPath)) {
                purgeQueueOnResume = true;
                resumeStartUrl = activeSession.startUrl;
            }
        }

        try {
            await startDiscoveryJob(projectPath, {
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
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to resume discovery",
                runtime: getDiscoveryState(projectPath),
            };
        }
    } finally {
        db.close();
    }
}
