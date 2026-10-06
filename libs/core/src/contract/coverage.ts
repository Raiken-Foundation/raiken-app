import { ContractStore } from "./store";
import { factPath } from "./impact";
import type { BehaviorFact, CoverageEntry, CoverageReport, IntentFact } from "./types";

/**
 * Requirement coverage: which intent facts does the observed side satisfy?
 *
 * Matching is deterministic token overlap between the requirement text
 * (plus route hint) and each fact's action/observable/route — no LLM, no
 * network, fully explainable. An LLM-assisted pass can refine ambiguous cases
 * later; it must never be required to compute coverage.
 *
 * Two structural vetoes guard the floor, because round-3 dogfooding showed
 * the emptier the evidence, the more the contract claimed:
 *
 * - **Quoted-copy agreement.** A requirement that names exact UI copy
 *   (`shows "Please add your name"`) can only be satisfied by a fact whose
 *   observable asserts that copy. An existence fact ("the form is there")
 *   never satisfies a message requirement — and a fact quoting *different*
 *   copy never satisfies it either.
 * - **Route veto.** When both sides carry route signal and they disagree,
 *   the fact does not exercise the requirement's flow — an API AC is not
 *   covered by a heading fact on the home page, whatever the token overlap.
 */

export const COVERAGE_MATCH_THRESHOLD = 0.4;

/** Exact UI copy a requirement quotes (double or curly quotes, 2+ chars). */
function quotedExpectations(text: string): string[] {
    const matches = text.match(/["“”]([^"“”]{2,})["“”]/g) ?? [];
    return matches.map((m) => m.slice(1, -1));
}

/** Normalize a route hint for comparison (leading slash, no trailing slash). */
function normalizedHint(hint: string): string {
    const withSlash = hint.startsWith("/") ? hint : `/${hint}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : "/";
}

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

/** Jaccard-style overlap with a route-match bonus, behind the two vetoes. */
export function matchScore(
    intent: Pick<IntentFact, "requirementText" | "routeHint">,
    fact: Pick<BehaviorFact, "route" | "action" | "expectedObservable">,
): number {
    const hay = `${fact.action} ${fact.expectedObservable}`.toLowerCase();

    // Veto 1: quoted copy must be asserted by the fact, verbatim.
    for (const quote of quotedExpectations(intent.requirementText)) {
        if (!hay.includes(quote.toLowerCase())) return 0;
    }

    // Veto 2: route disagreement. Root ("/") on either side is treated as no
    // signal — it is the default home, not a location claim.
    const hint = intent.routeHint?.trim() ? normalizedHint(intent.routeHint.trim()) : null;
    if (hint && hint !== "/") {
        const fp = factPath(fact.route);
        const agree =
            fp === hint ||
            (fp !== "/" && fp.startsWith(`${hint}/`)) ||
            (fp !== "/" && hint.startsWith(`${fp}/`));
        if (!agree) return 0;
    }

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
 * intent facts. Matching runs over verified AND violated facts: a broken
 * fact must keep satisfying its requirement (as a violation), not vanish
 * from the pool — otherwise a recompute after a regression reads the
 * promise as merely "uncovered" and verify and coverage disagree (round-2
 * dogfood defect #9, resurfaced by the board). The best-scoring match
 * decides: violated fact → the requirement reads violated; verified fact →
 * covered; no match → uncovered.
 */
export function computeCoverage(store: ContractStore, threshold = COVERAGE_MATCH_THRESHOLD): CoverageReport {
    const intents = store.listIntentFacts();
    const observed = store
        .listBehaviorFacts()
        .filter((f) => f.status === "verified" || f.status === "violated");
    const entries: CoverageEntry[] = [];

    for (const intent of intents) {
        const matches = observed
            .map((fact) => ({ fact, score: matchScore(intent, fact) }))
            .filter((m) => m.score >= threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        const verdict: CoverageEntry["verdict"] =
            matches.length === 0
                ? "uncovered"
                : matches[0].fact.status === "violated"
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
