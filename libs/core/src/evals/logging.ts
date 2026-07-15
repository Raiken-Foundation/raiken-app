/**
 * Silence Crawlee's global logger — used internally by the playground
 * scenarios' `SiteDiscovery` target. Crawlee logs straight to stdout at INFO
 * by default, which corrupts `raiken eval --json`'s promise that stdout is
 * JSON and nothing else. A no-op for scenarios that never touch Crawlee.
 *
 * Lives here (not called directly from `apps/cli`) so callers never need
 * "crawlee" resolvable as a direct dependency — only `@raiken/core` does.
 */
export async function silenceCrawleeLogging(): Promise<void> {
    const { log, LogLevel } = await import("crawlee");
    log.setLevel(LogLevel.OFF);
}
