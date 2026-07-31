import {
    getDiscoveryQueryService,
    invalidateDiscoveryQueryService,
} from "../discovery-query-cache";
import { startDiscoveryJob } from "./execution";
import { hydrateDiscoveryStateCore } from "./state-hydrator";
import type { DiscoveryRuntimeState } from "./types";

function getSharedDiscoveryQuery(projectPath: string) {
    return getDiscoveryQueryService(projectPath);
}

export async function hydrateDiscoveryState(projectPath: string): Promise<DiscoveryRuntimeState> {
    return hydrateDiscoveryStateCore(projectPath, startDiscoveryJob);
}

export function invalidateDiscoveryQuery(projectPath: string): void {
    invalidateDiscoveryQueryService(projectPath);
}

export async function getResumeContext(projectPath: string): Promise<{
    session: import("../../site-discovery/types").DiscoverySession | null;
    pendingAuthBlockers: import("../../site-discovery/types").DiscoveryBlocker[];
}> {
    const query = getSharedDiscoveryQuery(projectPath);
    const session = query.getLatestSession();
    const pendingAuthBlockers = query
        .getUnresolvedBlockers()
        .filter((b) => b.category === "auth_required");
    return { session, pendingAuthBlockers };
}
