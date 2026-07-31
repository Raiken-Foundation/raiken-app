import * as fs from "node:fs";
import * as path from "node:path";
import { Configuration, MemoryStorage, PlaywrightCrawler, type RequestQueue } from "crawlee";
import { looksLikeLoginUrl } from "../detectors/auth";
import { summariseNavigationFailure } from "./failure-summary";
import type { FailedRequestRecord } from "./types";

export type EmptyCrawlDiagnosticsInput = {
    startUrl: string;
    failedRequests: FailedRequestRecord[];
    authBlockersFound: number;
    handlerInvoked: boolean;
    resolvedLoginShapedUrls: Set<string>;
};

/**
 * Compose the user-facing error for a crawl that completed without
 * discovering any pages. Includes whatever diagnostic context we
 * captured (failed requests, blockers detected) so the user knows
 * whether to (a) check the URL, (b) authenticate first, or (c) try a
 * non-headless browser for anti-bot-protected sites.
 */
export function buildEmptyCrawlError(input: EmptyCrawlDiagnosticsInput): string {
    const parts: string[] = [`No pages discovered at ${input.startUrl}.`];

    if (input.failedRequests.length > 0) {
        const byReason = new Map<string, number>();
        for (const f of input.failedRequests) {
            byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
        }
        const summary = Array.from(byReason.entries())
            .map(([reason, count]) => (count > 1 ? `${reason} (×${count})` : reason))
            .join("; ");
        parts.push(`${input.failedRequests.length} request(s) failed: ${summary}.`);
        const samples = input.failedRequests
            .slice(0, 3)
            .map((failure) => `${failure.url} — ${failure.reason}`)
            .join("; ");
        parts.push(`Failed request samples: ${samples}.`);
    }

    if (input.authBlockersFound > 0) {
        parts.push(
            `${input.authBlockersFound} blocker(s) were detected but downgraded to log-only — every page was gated. Try resolving the first blocker (e.g. \`raiken auth\` or the dashboard's "Open in browser" button) and re-running.`,
        );
    }

    const loginShapedSamples = new Set<string>();
    if (looksLikeLoginUrl(input.startUrl)) {
        loginShapedSamples.add(input.startUrl);
    }
    for (const url of input.resolvedLoginShapedUrls) {
        loginShapedSamples.add(url);
    }
    const sawLoginShapedUrl = loginShapedSamples.size > 0;

    if (
        input.failedRequests.length === 0 &&
        input.authBlockersFound === 0 &&
        !input.handlerInvoked
    ) {
        parts.push(
            `The crawler completed without dispatching any requests — likely a stale Crawlee request-queue cache from a previous run on the same URL. Restart \`raiken start\` to clear the in-process cache, or report this if it persists across restarts.`,
        );
    } else if (
        input.failedRequests.length === 0 &&
        input.authBlockersFound === 0 &&
        sawLoginShapedUrl
    ) {
        const sample = Array.from(loginShapedSamples)[0];
        parts.push(
            `The crawl resolved to a login-shaped URL (${sample}) but no detector fired — this often means a magic-link or OAuth-only login flow that hides the standard \`<input type="password">\` field. Run \`raiken auth --url ${input.startUrl}\` to log in interactively, or pass \`--skip-auth\` to skip protected routes.`,
        );
    } else if (input.failedRequests.length === 0 && input.authBlockersFound === 0) {
        parts.push(
            `The request handler ran, but no page record was committed (0 navigation failures, 0 auth blockers). This points to content capture or persistence rather than basic reachability. In the interactive terminal, run \`/goto ${input.startUrl}\` followed by \`/snapshot\`: if a DOM appears, retry discovery and report the output; if it does not, the page is empty, non-HTML, or blocking Chromium.`,
        );
    } else if (input.failedRequests.some((f) => /timeout|net::|closed/i.test(f.reason))) {
        parts.push(
            "Sites with strong anti-bot protection (e.g. social networks, paywalled news) often refuse headless Chromium. Discovery currently runs headless only.",
        );
    }

    return parts.join(" ");
}

export type CrawlerRuntimeSetupInput = {
    projectPath: string;
    maxPages: number;
    maxConcurrency: number;
    timeout: number;
    requestQueue: RequestQueue;
    storageState: import("./types").PlaywrightStorageState | null;
    onFailedRequest: (args: { url: string; reason: string; status: number | null }) => void;
};

export type CrawlerRuntimeSetupResult = {
    crawler: PlaywrightCrawler;
    crawleeDir: string;
};

export function installFreshCrawleeStorage(projectPath: string): string {
    const crawleeDir = path.join(projectPath, ".raiken", "crawlee");
    fs.mkdirSync(crawleeDir, { recursive: true });
    process.env["CRAWLEE_STORAGE_DIR"] = crawleeDir;

    const fresh = new MemoryStorage({
        localDataDirectory: crawleeDir,
        persistStorage: false,
    });
    Configuration.getGlobalConfig().useStorageClient(fresh);
    Configuration.getGlobalConfig().set("purgeOnStart", true);

    return crawleeDir;
}

export function buildPlaywrightCrawler(input: CrawlerRuntimeSetupInput): PlaywrightCrawler {
    const navTimeoutSecs = Math.max(input.timeout, 5_000) / 1000;
    const handlerTimeoutSecs = Math.max(navTimeoutSecs * 3, 60);

    const crawleeRequestCap = Math.max(Math.ceil(input.maxPages * 1.5), input.maxPages + 10);

    const storageStateForContext = input.storageState;

    return new PlaywrightCrawler({
        maxRequestsPerCrawl: crawleeRequestCap,
        maxConcurrency: input.maxConcurrency,
        requestHandlerTimeoutSecs: handlerTimeoutSecs,
        navigationTimeoutSecs: navTimeoutSecs,
        headless: true,
        requestQueue: input.requestQueue,
        sessionPoolOptions: { blockedStatusCodes: [] },
        launchContext: {
            launchOptions: {},
            ...(storageStateForContext ? { useIncognitoPages: true } : {}),
        },
        browserPoolOptions: storageStateForContext
            ? {
                  prePageCreateHooks: [
                      (_pageId, _browserController, pageOptions) => {
                          if (pageOptions) {
                              (pageOptions as { storageState?: unknown }).storageState =
                                  storageStateForContext;
                          }
                      },
                  ],
              }
            : undefined,
        failedRequestHandler: async ({ request, response }, error) => {
            const status = typeof response?.status === "function" ? response.status() : null;
            const reason = summariseNavigationFailure(error, status);
            input.onFailedRequest({ url: request.url, reason, status });
        },
    });
}

export function computeCrawleeRequestCap(maxPages: number): number {
    return Math.max(Math.ceil(maxPages * 1.5), maxPages + 10);
}

export function computeHandlerTimeouts(timeoutMs: number): {
    navTimeoutSecs: number;
    handlerTimeoutSecs: number;
} {
    const navTimeoutSecs = Math.max(timeoutMs, 5_000) / 1000;
    const handlerTimeoutSecs = Math.max(navTimeoutSecs * 3, 60);
    return { navTimeoutSecs, handlerTimeoutSecs };
}
