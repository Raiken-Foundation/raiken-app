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

import { AgentMemory } from "../agent/memory";
import { resolveAuthStorageStateRelativePath } from "../config/auth-state";
import { CodeGraphDB } from "../database/db";
import { looksLikeLoginUrl } from "../site-discovery/detectors/auth";
import { loadSiteKnowledge } from "../site-discovery/knowledge-loader";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import { readPlaywrightBaseURL } from "../testing/playwright-config";
import type { TemplateSelector } from "../types";
import { loadRecordedCoverFlows, persistCoverFlows } from "./flow-store";
import { buildNavigationFlows, type CoverFlow } from "./flows";

/** Observed login form persisted by interruption detection / discovery. */
export interface AuthLoginEvidence {
    url: string | null;
    fields: Array<{ label: string; type: string | null; selector: string | null }>;
    submit: string | null;
}

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
    /** Login form observed on a prior agent/discover pass, when known. */
    authLogin: AuthLoginEvidence | null;
    /** True when a reusable Playwright storageState exists for this project. */
    hasStorageState: boolean;
    /**
     * True when at least one captured page was crawled with a session loaded.
     * `hasStorageState` only says somebody logged in once; this says the
     * signed-in application was actually looked at, which is what a post-login
     * draft needs in order to assert real UI.
     */
    hasAuthenticatedKnowledge: boolean;
    /**
     * Short multi-step navigation chains from verified discovery links,
     * ranked for the scenario. Empty when the link graph is thin.
     */
    flows: CoverFlow[];
}

/**
 * Evidence for repairing an existing spec: the discovery snapshots that match
 * the spec's own text, the selector facts in source markup, and the set of
 * URL origins the project is known to talk to. `knownOrigins` exists for the
 * no-new-origins lint — a "fix" that navigates to an origin found in neither
 * the spec nor the knowledge DB is a hallucination, not a repair.
 */
export interface RepairEvidence {
    snapshots: string[];
    sourceSelectors: TemplateSelector[];
    knownOrigins: Set<string>;
    baseURL: string | null;
    authLogin: AuthLoginEvidence | null;
}

const MAX_PAGES = 20;
const MAX_SNAPSHOTS = 4;
const MAX_SNAPSHOT_CHARS = 1600;
const MAX_SOURCE_SELECTORS = 300;
const MAX_KNOWN_SELECTORS = 15;

/** True when the scenario is about signing in / credentials / the login page. */
export function looksLikeAuthScenario(text: string): boolean {
    return /\b(log[\s-]?in|sign[\s-]?in|auth(enticat|orisation|orization)?|credentials?|password|username)\b/i.test(
        text,
    );
}

/**
 * Parse the `auth_login` preference written when the agent hits a login form.
 * Returns null when absent or malformed.
 */
export function readAuthLoginEvidence(projectPath: string): AuthLoginEvidence | null {
    try {
        const raw = AgentMemory.getInstance(projectPath).getPreference("auth_login");
        if (!raw?.trim()) return null;
        const parsed = JSON.parse(raw) as {
            url?: unknown;
            fields?: unknown;
            submit?: unknown;
        };
        const fields = Array.isArray(parsed.fields)
            ? parsed.fields
                  .map((field) => {
                      if (!field || typeof field !== "object") return null;
                      const row = field as Record<string, unknown>;
                      const label = typeof row["label"] === "string" ? row["label"] : null;
                      if (!label) return null;
                      return {
                          label,
                          type: typeof row["type"] === "string" ? row["type"] : null,
                          selector: typeof row["selector"] === "string" ? row["selector"] : null,
                      };
                  })
                  .filter((field): field is NonNullable<typeof field> => field !== null)
            : [];
        return {
            url: typeof parsed.url === "string" ? parsed.url : null,
            fields,
            submit: typeof parsed.submit === "string" ? parsed.submit : null,
        };
    } catch {
        return null;
    }
}

/**
 * True when cover/repair already has something to ground an auth flow:
 * observed login fields, a login-shaped discovery snapshot, or storageState.
 */
export function hasAuthGrounding(evidence: {
    authLogin: AuthLoginEvidence | null;
    snapshots: string[];
    pages?: Array<{ url: string }>;
    hasStorageState?: boolean;
}): boolean {
    if (evidence.hasStorageState) return true;
    if (evidence.authLogin && (evidence.authLogin.fields.length > 0 || evidence.authLogin.url)) {
        return true;
    }
    if (evidence.snapshots.some((snap) => /Page:\s*\S*login|password|sign[\s-]?in/i.test(snap))) {
        return true;
    }
    if (evidence.pages?.some((page) => looksLikeLoginUrl(page.url))) return true;
    return false;
}

export function formatAuthLoginEvidence(authLogin: AuthLoginEvidence): string {
    const lines = [
        `[OBSERVED LOGIN FORM — use these labels/selectors; do not invent Email vs Username]`,
        authLogin.url ? `- URL: ${authLogin.url}` : null,
        ...authLogin.fields.map(
            (field) =>
                `- field "${field.label}"${field.type ? ` (type=${field.type})` : ""}${
                    field.selector ? ` → ${field.selector}` : ""
                }`,
        ),
        authLogin.submit ? `- submit: ${authLogin.submit}` : null,
    ].filter(Boolean);
    return lines.join("\n");
}

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
        authLogin: null,
        hasStorageState: Boolean(resolveAuthStorageStateRelativePath(projectPath)),
        hasAuthenticatedKnowledge: false,
        flows: [],
    };

    try {
        evidence.baseURL = (await readPlaywrightBaseURL(projectPath)) ?? null;
    } catch {
        // No playwright config (yet) — the draft can still use relative gotos.
    }

    evidence.authLogin = readAuthLoginEvidence(projectPath);

    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            evidence.hasAuthenticatedKnowledge = discovery.getStats().authenticatedPagesCount > 0;
            const { pages } = discovery.listPages({ limit: 200 });
            evidence.pages = pages
                .slice(0, MAX_PAGES)
                .map((page) => ({ url: page.url, title: page.title ?? null }));

            const ranked = rankPagesByScenario(pages, description, {
                preferLogin: looksLikeAuthScenario(description),
            });
            for (const page of ranked.slice(0, MAX_SNAPSHOTS)) {
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
        const knowledge = await loadSiteKnowledge(projectPath);
        if (knowledge && knowledge.verifiedPaths.length > 0) {
            const formsByUrl = new Map(
                knowledge.routes.map((route) => [route.url, route.forms] as const),
            );
            evidence.flows = buildNavigationFlows(knowledge.verifiedPaths, description, formsByUrl);
            if (evidence.flows.length > 0) {
                persistCoverFlows(projectPath, evidence.flows, "discovery");
            }
            // Prefer recorded flows (login + prior discovery) when present;
            // keep freshly built chains too, deduped by label.
            const recorded = loadRecordedCoverFlows(projectPath);
            if (recorded.length > 0) {
                const seen = new Set(evidence.flows.map((f) => f.label));
                for (const flow of recorded) {
                    if (!seen.has(flow.label)) {
                        evidence.flows.unshift(flow);
                        seen.add(flow.label);
                    }
                }
                evidence.flows = evidence.flows.slice(0, 6);
            }
            for (const flow of evidence.flows) {
                for (const step of flow.steps) {
                    if (step.linkText) {
                        evidence.sourceSelectors.push({
                            kind: "label",
                            value: step.linkText,
                            line: 0,
                        });
                    }
                    // Raw CSS/test-id selectors from the crawl also count as grounded.
                    const testId = /\[(?:data-testid|data-test)=['"]([^'"]+)['"]\]/.exec(
                        step.selector,
                    );
                    if (testId?.[1]) {
                        evidence.sourceSelectors.push({
                            kind: "testId",
                            value: testId[1],
                            line: 0,
                        });
                    }
                }
                for (const selector of flow.selectors) {
                    if (!evidence.knownSelectors.some((entry) => entry.selector === selector)) {
                        evidence.knownSelectors.push({
                            element: `flow:${flow.label}`,
                            selector,
                        });
                    }
                }
            }
        }
    } catch {
        // Knowledge loader failed — leave flows empty.
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

export async function gatherRepairEvidence(
    projectPath: string,
    referenceText: string,
): Promise<RepairEvidence> {
    const evidence: RepairEvidence = {
        snapshots: [],
        sourceSelectors: [],
        knownOrigins: new Set<string>(),
        baseURL: null,
        authLogin: null,
    };

    try {
        evidence.baseURL = (await readPlaywrightBaseURL(projectPath)) ?? null;
        const origin = toOrigin(evidence.baseURL);
        if (origin) evidence.knownOrigins.add(origin);
    } catch {
        // No playwright config.
    }

    evidence.authLogin = readAuthLoginEvidence(projectPath);

    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            const { pages } = discovery.listPages({ limit: 200 });
            for (const page of pages) {
                const origin = toOrigin(page.url);
                if (origin) evidence.knownOrigins.add(origin);
            }
            const ranked = rankPagesByScenario(pages, referenceText, {
                preferLogin: looksLikeAuthScenario(referenceText),
                preferUrlMentions: true,
            });
            for (const page of ranked.slice(0, MAX_SNAPSHOTS)) {
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
        // No site knowledge.
    }

    try {
        const db = new CodeGraphDB(projectPath);
        try {
            evidence.sourceSelectors = collectTemplateSelectors(db);
        } finally {
            db.close();
        }
    } catch {
        // No code graph.
    }

    return evidence;
}

/** Absolute URLs referenced in a blob of test code / run output. */
export function extractOrigins(text: string): Set<string> {
    const origins = new Set<string>();
    for (const match of text.matchAll(/https?:\/\/[^\s'"`)\]]+/g)) {
        const origin = toOrigin(match[0]);
        if (origin) origins.add(origin);
    }
    return origins;
}

function toOrigin(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * Score discovered pages against the scenario words so the prompt carries the
 * snapshots most likely to contain the flow under test. Zero-score pages fall
 * back to crawl order, which puts the start page first — the least-bad default
 * for a scenario whose words match no URL (e.g. wording taken from a ticket).
 *
 * When `preferLogin` is set, login-shaped URLs get a hard boost so auth
 * scenarios do not under-weight `/login`. When `preferUrlMentions` is set,
 * pages whose path appears in the reference text (failure output / spec) win
 * over free-text similarity alone.
 */
export function rankPagesByScenario(
    pages: Array<{ url: string; title?: string | null }>,
    description: string,
    options: { preferLogin?: boolean; preferUrlMentions?: boolean } = {},
): Array<{ url: string; title?: string | null }> {
    const words = Array.from(
        new Set(
            description
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 3),
        ),
    );
    const haystackText = description.toLowerCase();
    const scored = pages.map((page, order) => {
        const haystack = `${page.url} ${page.title ?? ""}`.toLowerCase();
        let score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0);
        if (options.preferLogin && looksLikeLoginUrl(page.url)) {
            score += 50;
        }
        if (options.preferUrlMentions) {
            try {
                const pathname = new URL(page.url).pathname.replace(/\/$/, "") || "/";
                if (pathname.length > 1 && haystackText.includes(pathname.toLowerCase())) {
                    score += 100;
                }
            } catch {
                /* ignore malformed page URLs */
            }
            // Relative gotos in the spec / failure: page.goto('/login')
            const relativeHits = description.matchAll(
                /(?:goto|URL|waiting for|navigat\w*)\s*(?:\([^)]*)?['"`](\/[^'"`\s]*)/gi,
            );
            for (const match of relativeHits) {
                const path = match[1]?.replace(/\/$/, "") || "/";
                if (path.length > 1 && haystack.includes(path.toLowerCase())) {
                    score += 100;
                    break;
                }
            }
        }
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
