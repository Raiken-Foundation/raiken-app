import { ContractStore } from "./store";
import type { BehaviorFact, CoverageEntry, CoverageReport, IntentFact } from "./types";

/**
 * Requirement coverage: which intent facts does the observed side satisfy?
 *
 * v1 matching is deterministic token overlap between the requirement text
 * (plus route hint) and each fact's action/observable/route — no LLM, no
 * network, fully explainable. An LLM-assisted pass can refine ambiguous cases
 * later; it must never be required to compute coverage.
 */

export const COVERAGE_MATCH_THRESHOLD = 0.34;

/** Normalize text into lowercase word tokens, dropping stopwords. */
function tokens(text: string): Set<string> {
    const STOP = new Set([
        "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
        "is", "are", "be", "shows", "show", "must", "should", "when", "user",
        "page", "app", "this", "that", "it", "as", "at", "by", "from",
    ]);
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 2 && !STOP.has(t))
            // Light stemming so "adding"/"adds" match "add" — full
            // normalization belongs to a proper stemmer, but requirement
            // wording varies more than fact wording and this closes most of it.
            .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es)$/, "") : t))
            .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)),
    );
}

/** Jaccard-style overlap with a route-match bonus. */
export function matchScore(
    intent: Pick<IntentFact, "requirementText" | "routeHint">,
    fact: Pick<BehaviorFact, "route" | "action" | "expectedObservable">,
): number {
    const want = tokens(`${intent.requirementText} ${intent.routeHint ?? ""}`);
    if (want.size === 0) return 0;
    const have = tokens(`${fact.action} ${fact.expectedObservable}`);
    let hits = 0;
    for (const t of want) if (have.has(t)) hits++;
    let score = hits / want.size;
    // Route agreement is strong evidence the fact exercises the requirement's flow.
    if (
        intent.routeHint &&
        (fact.route.includes(intent.routeHint) || intent.routeHint.includes(fact.route))
    ) {
        score = Math.min(1, score + 0.2);
    }
    return score;
}

/**
 * Compute the coverage report and persist the derived status back onto the
 * intent facts (`uncovered`/`covered`; `violated` is set by the verifier when
 * a matched fact later breaks — preserved here if already set).
 */
export function computeCoverage(store: ContractStore, threshold = COVERAGE_MATCH_THRESHOLD): CoverageReport {
    const intents = store.listIntentFacts();
    const observed = store.listBehaviorFacts("verified");
    const entries: CoverageEntry[] = [];

    for (const intent of intents) {
        const matches = observed
            .map((fact) => ({ fact, score: matchScore(intent, fact) }))
            .filter((m) => m.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        // A previously-violated intent stays violated until a fresh observed
        // fact covers it (the verifier clears it on re-verification).
        const verdict: CoverageEntry["verdict"] =
            matches.length === 0
                ? "uncovered"
                : intent.status === "violated"
                  ? "violated"
                  : "covered";

        store.setIntentCoverage(intent.id!, verdict, matches[0]?.fact.id ?? null);
        entries.push({ intent: { ...intent, status: verdict }, matches, verdict });
    }

    return {
        total: entries.length,
        covered: entries.filter((e) => e.verdict === "covered").length,
        uncovered: entries.filter((e) => e.verdict === "uncovered").length,
        violated: entries.filter((e) => e.verdict === "violated").length,
        neverRegressUncovered: entries.filter((e) => e.verdict === "uncovered" && e.intent.neverRegress).length,
        entries,
        computedAt: Date.now(),
    };
}
