/**
 * Blocker detector framework.
 *
 * A `BlockerDetector` inspects a single page (with optional response) and
 * either returns a fully-populated `DiscoveryBlocker` describing why the
 * crawl should pause, or `null` if it has nothing to say. The crawler
 * runs detectors in priority order (lower number = higher priority) and
 * uses the first match.
 *
 * Detectors are intentionally side-effect-free aside from page reads; they
 * never write to the DB, never emit events, and never decide whether to
 * pause. That decision lives in the crawler so a single place applies the
 * `pauseOnAuth` flag, session-scoped skip lists, and ignored-category
 * memory uniformly across detectors.
 */

import type { Page, Response } from "playwright";

import type { BlockerCategory, DiscoveryBlocker } from "../types";

export interface BlockerDetectorContext {
    /** Project root — detectors put it on the blocker for storage. */
    projectPath: string;
    /** The URL the crawler just navigated to (post-redirects). */
    url: string;
    /** Playwright page; safe to call locator/content; do NOT navigate. */
    page: Page;
    /** Final HTTP response (or undefined if Playwright produced none). */
    response?: Response;
}

export interface BlockerDetector {
    /** Stable id used in evidence trails and tests (`auth:url_pattern`). */
    readonly id: string;
    /** What category any blocker this detector emits will carry. */
    readonly category: BlockerCategory;
    /**
     * Lower runs first. Auth lives at 100 today; cheap response-status
     * checks should be < 100, expensive DOM scrapes > 100.
     */
    readonly priority: number;
    /**
     * Return the blocker describing what's in the way, or `null` to
     * abstain. MUST NOT throw — wrap your own implementation in
     * `try/catch` or use the helpers in `detectors/util.ts`.
     */
    detect(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null>;
}

/**
 * Build a base `DiscoveryBlocker` with the boring fields filled in. Lets
 * detector authors focus on category/severity/evidence and forget the
 * resolution columns (which only get populated when the user resolves it).
 */
export function buildBlocker(args: {
    ctx: BlockerDetectorContext;
    detectorId: string;
    category: BlockerCategory;
    severity?: DiscoveryBlocker["severity"];
    evidence: Record<string, unknown>;
    screenshotPath?: string | null;
}): DiscoveryBlocker {
    const evidenceJson = JSON.stringify(args.evidence);
    return {
        projectPath: args.ctx.projectPath,
        url: args.ctx.url,
        category: args.category,
        severity: args.severity ?? "pause",
        detectorId: args.detectorId,
        detectedElements: evidenceJson,
        evidenceJson,
        screenshotPath: args.screenshotPath ?? null,
        resolution: null,
        resolvedVia: null,
        resolvedAt: null,
        storageStatePath: null,
        discoveredAt: Date.now(),
    };
}

/**
 * Run every detector in priority order, returning the first non-ignored
 * match. A detector that throws is logged once and skipped — one bad detector
 * shouldn't stop the rest of the pipeline from running.
 */
export async function runBlockerPipeline(
    detectors: BlockerDetector[],
    ctx: BlockerDetectorContext,
    options: { skipCategories?: ReadonlySet<BlockerCategory> } = {},
): Promise<DiscoveryBlocker | null> {
    const ordered = [...detectors].sort((a, b) => a.priority - b.priority);
    for (const detector of ordered) {
        try {
            const blocker = await detector.detect(ctx);
            if (!blocker) continue;
            if (options.skipCategories?.has(blocker.category)) continue;
            return blocker;
        } catch (err) {
            // Best-effort: a detector that crashes shouldn't take down
            // the crawl. Surface the failure on the console so the user
            // can grep for it, but keep moving.
            console.warn(
                `[detector:${detector.id}] threw during detect(); skipping for ${ctx.url}:`,
                err instanceof Error ? err.message : err,
            );
        }
    }
    return null;
}
