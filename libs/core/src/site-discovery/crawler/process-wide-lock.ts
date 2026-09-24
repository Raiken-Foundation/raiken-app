let activeProcessWideCrawl: object | null = null;

export function getActiveProcessWideCrawl(): object | null {
    return activeProcessWideCrawl;
}

export function tryAcquireProcessWideCrawl(instance: object): void {
    if (activeProcessWideCrawl && activeProcessWideCrawl !== instance) {
        throw new Error(
            "Another discovery crawl is already running in this process. Crawlee's " +
                "global configuration can't be safely shared between concurrent crawls " +
                "— wait for the other crawl to finish (or call close() on it) before " +
                "starting a new one.",
        );
    }
    activeProcessWideCrawl = instance;
}

export function releaseProcessWideCrawl(instance: object): void {
    if (activeProcessWideCrawl === instance) {
        activeProcessWideCrawl = null;
    }
}
