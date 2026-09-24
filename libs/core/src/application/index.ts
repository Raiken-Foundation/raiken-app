import { readPlaywrightBaseURL } from "../testing/playwright-config";
import { ChatApplication } from "./chat";
import { ConfigApplication } from "./config";
import {
    __resetBackgroundDiscoverForTests,
    type BackgroundDiscoverState,
    DiscoveryApplication,
    type DiscoveryUxCallbacks,
    getResumeContext,
    isDiscoveryActive,
    MAX_DISCOVERY_EVENTS,
    type RunForegroundInput,
    resolveAuthBlockersWithState,
    toIsoDate,
} from "./discovery";
import { HitlApplication } from "./hitl";
import { IndexingApplication } from "./indexing";
import { QualityApplication } from "./quality";
import {
    createProjectApplication,
    disposeAllProjectApplications,
    disposeProjectApplication,
    getProjectApplication,
    isProjectApplicationDisposable,
    type ProjectApplication,
} from "./registry";
import { TestingApplication } from "./testing";

export type { ProjectApplicationContext } from "./context";
export type { ContractScope } from "./contract";
export { assertUnderProjectRoot, writeFileAtomic } from "./paths";
export {
    ChatApplication,
    ConfigApplication,
    DiscoveryApplication,
    HitlApplication,
    IndexingApplication,
    QualityApplication,
    TestingApplication,
    MAX_DISCOVERY_EVENTS,
    __resetBackgroundDiscoverForTests,
    getResumeContext,
    isDiscoveryActive,
    resolveAuthBlockersWithState,
    toIsoDate,
    type BackgroundDiscoverState,
    type DiscoveryUxCallbacks,
    type RunForegroundInput,
};
export {
    createProjectApplication,
    disposeAllProjectApplications,
    disposeProjectApplication,
    getProjectApplication,
    isProjectApplicationDisposable,
    type ProjectApplication,
};
export { canonicalProjectPath } from "./discovery-query-cache";
export {
    __resetDiscoveryQueryCacheForTests,
    __resetProjectApplicationRegistryForTests,
} from "./registry";

/** Read Playwright base URL for discovery form defaults. */
export async function getDiscoveryDefaults(
    projectPath: string,
): Promise<{ baseURL: string | null }> {
    try {
        const baseURL = await readPlaywrightBaseURL(projectPath);
        return { baseURL };
    } catch {
        return { baseURL: null };
    }
}
