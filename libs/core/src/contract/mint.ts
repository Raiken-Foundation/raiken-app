import type Database from "better-sqlite3";
import { SqliteDbAdapter } from "../database/adapter";
import { ContractStore } from "./store";
import type { BehaviorFact, FactEvidence } from "./types";

/**
 * The mint: converts captured evidence into observed facts.
 *
 * Only grounded observations become facts — every mint path requires evidence
 * it can point at (a captured aria snapshot, a before/after DOM pair). This is
 * the discipline layer made structural: nothing is asserted about the app
 * that was not read off the app.
 */

export interface MintResult {
    minted: number;
    refreshed: number;
    facts: Array<{ factKey: string; route: string; action: string; expectedObservable: string }>;
}

interface DiscoveredPageRow {
    url: string;
    normalized_url: string;
    title: string | null;
    snapshot_json: string | null;
    forms_json: string | null;
    captured_authenticated: number;
}

/**
 * Mint structural facts from site knowledge: per page, what it renders
 * (headings, key interactive elements) and what forms it exposes. This runs
 * against the existing `discovered_pages` table — discovery data becomes
 * contract facts without re-crawling.
 */
export function mintFromSiteKnowledge(db: Database.Database, projectPath: string): MintResult {
    const store = new ContractStore(new SqliteDbAdapter(db, projectPath));

    const pages = db
        .prepare(
            `SELECT url, normalized_url, title, snapshot_json, forms_json, captured_authenticated
             FROM discovered_pages WHERE project_path = ?`,
        )
        .all(projectPath) as DiscoveredPageRow[];

    let minted = 0;
    let refreshed = 0;
    const facts: MintResult["facts"] = [];

    for (const page of pages) {
        if (!page.snapshot_json) continue;
        const evidence: FactEvidence = {
            source: "discovery",
            capturedAt: Date.now(),
            observedUrl: page.url,
            snapshotExcerpt: page.snapshot_json.slice(0, 400),
        };
        const precondition = page.captured_authenticated ? "signed in" : null;

        // 1. Page renders its title/heading set — the existence fact.
        const headings = extractHeadings(page.snapshot_json);
        for (const heading of headings) {
            const { factKey, isNew } = store.upsertBehaviorFact({
                route: page.normalized_url,
                precondition,
                action: `open ${page.normalized_url}`,
                expectedObservable: `shows heading "${heading}"`,
                status: "verified",
                evidence,
                sourceCommit: null,
                capturedAt: Date.now(),
                lastVerifiedAt: null,
                verifiedCount: 0,
                violatedCount: 0,
            });
            isNew ? minted++ : refreshed++;
            facts.push({
                factKey,
                route: page.normalized_url,
                action: "open",
                expectedObservable: `heading "${heading}"`,
            });
        }

        // 2. Forms: fields + submit labels — the input surface fact.
        if (page.forms_json) {
            const forms = safeParse(page.forms_json) as
                | { fields?: Array<{ label?: string }>; submits?: string[] }
                | null;
            if (forms?.fields?.length) {
                const labels = forms.fields
                    .map((f) => f.label)
                    .filter((l): l is string => Boolean(l))
                    .slice(0, 8);
                const submits = (forms.submits ?? []).slice(0, 4);
                if (labels.length > 0) {
                    const { factKey, isNew } = store.upsertBehaviorFact({
                        route: page.normalized_url,
                        precondition,
                        action: `view form on ${page.normalized_url}`,
                        expectedObservable: `exposes inputs [${labels.join(", ")}]${
                            submits.length ? ` and submit [${submits.join(", ")}]` : ""
                        }`,
                        status: "verified",
                        evidence,
                        sourceCommit: null,
                        capturedAt: Date.now(),
                        lastVerifiedAt: null,
                        verifiedCount: 0,
                        violatedCount: 0,
                    });
                    isNew ? minted++ : refreshed++;
                    facts.push({
                        factKey,
                        route: page.normalized_url,
                        action: "view form",
                        expectedObservable: `inputs [${labels.join(", ")}]`,
                    });
                }
            }
        }
    }

    return { minted, refreshed, facts };
}

/**
 * Mint a state-change fact from a live observation (the capture prober and,
 * later, the explorer and verifier). Exposed for reuse by Phase 2/3 callers.
 */
export function mintObservedFact(
    store: ContractStore,
    input: {
        route: string;
        precondition: string | null;
        action: string;
        expectedObservable: string;
        evidence: FactEvidence;
    },
): { factKey: string; isNew: boolean } {
    const result = store.upsertBehaviorFact({
        ...input,
        status: "verified",
        sourceCommit: null,
        capturedAt: Date.now(),
        lastVerifiedAt: null,
        verifiedCount: 0,
        violatedCount: 0,
    });
    return { factKey: result.factKey, isNew: result.isNew };
}

/** Parse top-level/level-1 headings out of an aria-snapshot YAML string. */
function extractHeadings(snapshotJson: string): string[] {
    const headings: string[] = [];
    for (const line of snapshotJson.split("\n")) {
        const match = line.match(/- heading "([^"]+)"(?: \[level=(\d+)\])?/);
        if (match && (match[2] ?? "2") <= "2") {
            const text = match[1].trim();
            if (text && headings.length < 5 && !headings.includes(text)) headings.push(text);
        }
    }
    return headings;
}

function safeParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export type { BehaviorFact };
