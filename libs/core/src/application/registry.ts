import { ChatApplication } from "./chat";
import { ConfigApplication } from "./config";
import { DiscoveryApplication, isDiscoveryActive } from "./discovery";
import {
    canonicalProjectPath,
    disposeAllDiscoveryQueryServices,
    invalidateDiscoveryQueryService,
} from "./discovery-query-cache";
import { HitlApplication } from "./hitl";
import { IndexingApplication } from "./indexing";
import { QualityApplication } from "./quality";
import { TestingApplication } from "./testing";

/** Bundled project-scoped application services (one instance per canonical path). */
export interface ProjectApplication {
    readonly projectPath: string;
    readonly chat: ChatApplication;
    readonly config: ConfigApplication;
    readonly discovery: DiscoveryApplication;
    readonly hitl: HitlApplication;
    readonly indexing: IndexingApplication;
    readonly quality: QualityApplication;
    readonly testing: TestingApplication;
    dispose(): void;
}

class ProjectApplicationBundle implements ProjectApplication {
    readonly projectPath: string;
    readonly chat: ChatApplication;
    readonly config: ConfigApplication;
    readonly discovery: DiscoveryApplication;
    readonly hitl: HitlApplication;
    readonly indexing: IndexingApplication;
    readonly quality: QualityApplication;
    readonly testing: TestingApplication;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
        this.chat = new ChatApplication(projectPath);
        this.config = new ConfigApplication(projectPath);
        this.discovery = new DiscoveryApplication(projectPath);
        this.hitl = new HitlApplication(projectPath);
        this.indexing = new IndexingApplication(projectPath);
        this.quality = new QualityApplication(projectPath);
        this.testing = new TestingApplication(projectPath);
    }

    dispose(): void {
        this.discovery.dispose();
        invalidateDiscoveryQueryService(this.projectPath);
    }
}

const MAX_CACHED_PROJECT_APPLICATIONS = 32;

const applicationCache = new Map<string, ProjectApplicationBundle>();

/** Evict idle bundles only — never drop an active discovery owner. Allows growth when all are active. */
function ensureCapacityBeforeInsert(): void {
    while (applicationCache.size >= MAX_CACHED_PROJECT_APPLICATIONS) {
        let evicted = false;
        for (const candidate of applicationCache.keys()) {
            if (!isProjectApplicationDisposable(candidate)) {
                continue;
            }
            applicationCache.get(candidate)?.dispose();
            applicationCache.delete(candidate);
            evicted = true;
            break;
        }
        if (!evicted) {
            break;
        }
    }
}

function bundleFor(projectPath: string): ProjectApplicationBundle {
    const key = canonicalProjectPath(projectPath);
    const existing = applicationCache.get(key);
    if (existing) {
        applicationCache.delete(key);
        applicationCache.set(key, existing);
        return existing;
    }
    ensureCapacityBeforeInsert();
    const bundle = new ProjectApplicationBundle(key);
    applicationCache.set(key, bundle);
    return bundle;
}

/** Cached project-scoped application bundle (canonical path key). */
export function getProjectApplication(projectPath: string): ProjectApplication {
    return bundleFor(projectPath);
}

/** @deprecated Prefer getProjectApplication — alias kept for external callers. */
export function createProjectApplication(projectPath: string): ProjectApplication {
    return getProjectApplication(projectPath);
}

export function isProjectApplicationDisposable(projectPath: string): boolean {
    return !isDiscoveryActive(projectPath);
}

/** Returns false when discovery is active and the bundle was retained. */
export function disposeProjectApplication(projectPath: string): boolean {
    const key = canonicalProjectPath(projectPath);
    if (isDiscoveryActive(key)) {
        return false;
    }
    const bundle = applicationCache.get(key);
    if (bundle) {
        bundle.dispose();
        applicationCache.delete(key);
    }
    return true;
}

export async function disposeAllProjectApplications(): Promise<void> {
    const aborts: Promise<unknown>[] = [];
    for (const bundle of applicationCache.values()) {
        if (isDiscoveryActive(bundle.projectPath)) {
            aborts.push(bundle.discovery.abort());
        }
    }
    await Promise.all(aborts);
    for (const bundle of applicationCache.values()) {
        bundle.dispose();
    }
    applicationCache.clear();
    disposeAllDiscoveryQueryServices();
}

/** Test helper — clear registry without closing SQLite (tests own temp dirs). */
export function __resetProjectApplicationRegistryForTests(): void {
    applicationCache.clear();
    disposeAllDiscoveryQueryServices();
}

/** Exposed for contract tests — current cache size may exceed LRU cap when all entries are active. */
export function __projectApplicationCacheSizeForTests(): number {
    return applicationCache.size;
}

export { __resetDiscoveryQueryCacheForTests } from "./discovery-query-cache";
