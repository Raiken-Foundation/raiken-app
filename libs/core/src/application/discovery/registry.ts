import { canonicalProjectPath } from "../discovery-query-cache";
import { DiscoveryProjectRuntime } from "./project-runtime";
import { discoveryJobStore, handoffJobStore } from "./state";

const projectRuntimes = new Map<string, DiscoveryProjectRuntime>();

/** Cross-project registry of per-project discovery runtimes (explicit, disposable). */
export function getDiscoveryProjectRuntime(projectPath: string): DiscoveryProjectRuntime {
    const key = canonicalProjectPath(projectPath);
    const existing = projectRuntimes.get(key);
    if (existing) return existing;
    const created = new DiscoveryProjectRuntime(key);
    projectRuntimes.set(key, created);
    return created;
}

export function disposeDiscoveryProjectRuntime(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const runtime = projectRuntimes.get(key);
    if (runtime) {
        runtime.dispose();
        projectRuntimes.delete(key);
    }
}

/** True while a crawl, abort, or active background run owns discovery state. */
export function isDiscoveryActive(projectPath: string): boolean {
    const key = canonicalProjectPath(projectPath);
    const runtime = projectRuntimes.get(key);
    if (discoveryJobStore.has(key) || runtime?.abortInFlight) {
        return true;
    }
    const background = runtime?.background;
    return background?.state.status === "running" || background?.state.status === "paused";
}

export function isBrowserHandoffInProgress(projectPath: string): boolean {
    const key = canonicalProjectPath(projectPath);
    return handoffJobStore.has(key) || (projectRuntimes.get(key)?.hasHandoffAbort ?? false);
}

/** Test helper — drop all per-project runtime handles. */
export function resetDiscoveryProjectRegistryForTests(): void {
    for (const runtime of projectRuntimes.values()) {
        runtime.dispose();
    }
    projectRuntimes.clear();
}

/** Exposed for contract tests at the registry seam. */
export function discoveryProjectRegistrySizeForTests(): number {
    return projectRuntimes.size;
}
