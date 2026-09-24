import * as fs from "node:fs";
import * as path from "node:path";
import { DiscoveryQueryService } from "../site-discovery/query-service";

const MAX_CACHED_QUERY_SERVICES = 32;

/** Canonical absolute project path → open query service (LRU-evicted). */
const queryServices = new Map<string, DiscoveryQueryService>();

export function canonicalProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

export function getDiscoveryQueryService(projectPath: string): DiscoveryQueryService {
    const key = canonicalProjectPath(projectPath);
    const existing = queryServices.get(key);
    if (existing) {
        queryServices.delete(key);
        queryServices.set(key, existing);
        return existing;
    }
    const created = new DiscoveryQueryService(key);
    queryServices.set(key, created);
    if (queryServices.size > MAX_CACHED_QUERY_SERVICES) {
        const oldest = queryServices.keys().next().value;
        if (oldest) {
            const evicted = queryServices.get(oldest);
            queryServices.delete(oldest);
            try {
                evicted?.close();
            } catch {
                // ignore
            }
        }
    }
    return created;
}

export function invalidateDiscoveryQueryService(projectPath: string): void {
    const key = canonicalProjectPath(projectPath);
    const svc = queryServices.get(key);
    if (svc) {
        try {
            svc.close();
        } catch {
            // ignore
        }
        queryServices.delete(key);
    }
}

export function disposeAllDiscoveryQueryServices(): void {
    for (const svc of queryServices.values()) {
        try {
            svc.close();
        } catch {
            // ignore
        }
    }
    queryServices.clear();
}

/** Test helper — drop cached handles without closing underlying DB files. */
export function __resetDiscoveryQueryCacheForTests(): void {
    queryServices.clear();
}
