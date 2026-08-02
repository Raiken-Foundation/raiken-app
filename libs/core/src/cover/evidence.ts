/**
 * Project evidence for `raiken cover`.
 *
 * Cover is one-shot and never opens a browser, but that must not mean it works
 * blind: the project usually already holds everything a draft needs — the
 * playwright baseURL, every page `raiken discover` crawled (with an ARIA
 * snapshot each), literal selectors from indexed component templates, and the
 * selector memory built up by previous runs. This module reads all of that
 * best-effort so the prompt can state real URLs and real locators instead of
 * instructing the model to emit TODO placeholders for facts we have on disk.
 *
 * Every reader here degrades to empty on error: a missing knowledge DB or an
 * unbuilt code graph must never make `cover` worse than it was without them.
 */

import { CodeGraphDB } from "../database/db";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import { readPlaywrightBaseURL } from "../testing/playwright-config";
import type { TemplateSelector } from "../types";

export interface CoverEvidence {
    /** baseURL from playwright.config, when one is set. */
    baseURL: string | null;
    /** Every discovered page (capped), so the model can pick real routes. */
    pages: Array<{ url: string; title: string | null }>;
    /**
     * ARIA snapshots of the discovered pages that best match the scenario
     * text, capped and truncated — prompt context plus grounding input.
     */
    snapshots: string[];
    /** Literal selector facts from indexed source markup. */
    sourceSelectors: TemplateSelector[];
    /** Selectors that worked in previous runs, highest confidence first. */
    knownSelectors: Array<{ element: string; selector: string }>;
}

const MAX_PAGES = 20;
const MAX_SNAPSHOTS = 4;
const MAX_SNAPSHOT_CHARS = 1600;
const MAX_SOURCE_SELECTORS = 300;
const MAX_KNOWN_SELECTORS = 15;

export async function gatherCoverEvidence(
    projectPath: string,
    description: string,
): Promise<CoverEvidence> {
    const evidence: CoverEvidence = {
        baseURL: null,
        pages: [],
        snapshots: [],
        sourceSelectors: [],
        knownSelectors: [],
    };

    try {
        evidence.baseURL = (await readPlaywrightBaseURL(projectPath)) ?? null;
    } catch {
        // No playwright config (yet) — the draft can still use relative gotos.
    }

    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            const { pages } = discovery.listPages({ limit: 200 });
            evidence.pages = pages
                .slice(0, MAX_PAGES)
                .map((page) => ({ url: page.url, title: page.title ?? null }));

            for (const page of rankPagesByScenario(pages, description).slice(0, MAX_SNAPSHOTS)) {
                const snapshot = discovery.getPageSnapshot(page.url)?.snapshotJson;
                if (!snapshot) continue;
                evidence.snapshots.push(
                    `Page: ${page.url}${page.title ? ` — "${page.title}"` : ""}\n${snapshot.slice(
                        0,
                        MAX_SNAPSHOT_CHARS,
                    )}`,
                );
            }
        } finally {
            discovery.close();
        }
    } catch {
        // No site knowledge — discovery has not run in this project.
    }

    try {
        const db = new CodeGraphDB(projectPath);
        try {
            evidence.sourceSelectors = collectTemplateSelectors(db);
            evidence.knownSelectors = db
                .getSuccessfulSelectors(MAX_KNOWN_SELECTORS)
                .map((entry) => ({ element: entry.element, selector: entry.selector }));
        } finally {
            db.close();
        }
    } catch {
        // No code graph — `raiken index` has not run in this project.
    }

    return evidence;
}

/**
 * Score discovered pages against the scenario words so the prompt carries the
 * snapshots most likely to contain the flow under test. Zero-score pages fall
 * back to crawl order, which puts the start page first — the least-bad default
 * for a scenario whose words match no URL (e.g. wording taken from a ticket).
 */
function rankPagesByScenario(
    pages: Array<{ url: string; title?: string | null }>,
    description: string,
): Array<{ url: string; title?: string | null }> {
    const words = Array.from(
        new Set(
            description
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 3),
        ),
    );
    const scored = pages.map((page, order) => {
        const haystack = `${page.url} ${page.title ?? ""}`.toLowerCase();
        const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
        return { page, score, order };
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.map((entry) => entry.page);
}

/**
 * Template selectors across the whole indexed graph. Whole-graph rather than
 * per-relevant-file: cover has no exploration step to narrow files with, and
 * a few hundred literals cost little prompt space compared to what a wrong
 * guessed selector costs in review time.
 */
function collectTemplateSelectors(db: CodeGraphDB): TemplateSelector[] {
    const selectors: TemplateSelector[] = [];
    for (const file of db.getFiles()) {
        if (selectors.length >= MAX_SOURCE_SELECTORS) break;
        if (!file.parsed_ast) continue;
        try {
            const parsed = JSON.parse(file.parsed_ast) as {
                templateSelectors?: TemplateSelector[];
            };
            if (parsed.templateSelectors?.length) {
                selectors.push(
                    ...parsed.templateSelectors.slice(0, MAX_SOURCE_SELECTORS - selectors.length),
                );
            }
        } catch {
            // A malformed AST row must not sink the whole evidence gather.
        }
    }
    return selectors;
}
