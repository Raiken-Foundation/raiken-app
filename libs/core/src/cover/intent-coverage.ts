/**
 * Cheap "did the draft check what was asked?" gate.
 *
 * Splits the scenario into criteria (AC lines when present, otherwise
 * then/and/newline clauses) and scores each against the draft's assertions
 * and actions via keyword overlap. Soft only — adds needsReview reasons,
 * never hard-blocks, because a false positive that refuses a good draft is
 * worse than a flag a human can dismiss.
 */

const STOPWORDS = new Set([
    "a",
    "an",
    "the",
    "to",
    "and",
    "or",
    "of",
    "in",
    "on",
    "at",
    "for",
    "with",
    "from",
    "into",
    "is",
    "are",
    "be",
    "been",
    "being",
    "as",
    "by",
    "that",
    "this",
    "it",
    "its",
    "user",
    "users",
    "can",
    "should",
    "must",
    "will",
    "when",
    "then",
    "after",
    "before",
    "page",
    "see",
    "sees",
    "seen",
    "show",
    "shows",
    "shown",
    "display",
    "displays",
    "visible",
    "appear",
    "appears",
    "click",
    "clicks",
    "fill",
    "fills",
    "enter",
    "enters",
    "go",
    "goes",
    "navigate",
    "open",
    "opens",
    "verify",
    "verifies",
    "check",
    "checks",
    "assert",
    "ensure",
    "confirm",
]);

export interface IntentCriterion {
    text: string;
    /** Significant tokens used for matching. */
    tokens: string[];
}

export interface IntentCoverageAssessment {
    criteria: IntentCriterion[];
    /** Criteria with no meaningful overlap against the draft. */
    uncovered: IntentCriterion[];
    /** Soft review reasons — one per uncovered criterion. */
    reasons: string[];
}

/** Tokenize a phrase into significant lowercase words (no stopwords, len≥3). */
export function significantTokens(text: string): string[] {
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s/-]/g, " ")
        .split(/[\s/-]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    return [...new Set(words)];
}

/**
 * Split a free-text scenario into checkable clauses when no AC list is present.
 * Prefers newline-separated steps; otherwise splits on " then " / " and then ".
 */
export function splitScenarioClauses(description: string): string[] {
    const trimmed = description.trim();
    if (!trimmed) return [];

    const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter((line) => line.length > 0);
    if (lines.length >= 2) return lines;

    const thenSplit = trimmed
        .split(/\b(?:and\s+)?then\b/i)
        .map((part) => part.trim().replace(/^[,.\s]+|[,.\s]+$/g, ""))
        .filter((part) => part.length > 0);
    if (thenSplit.length >= 2) return thenSplit;

    return [trimmed];
}

/**
 * Pull acceptance criteria from a ticket/description.
 * Preference order: `AC1:` / `AC-1:` prefixes → markdown checkboxes →
 * numbered lists. Returns [] when none of those conventions appear.
 *
 * If the description mixes conventions, AC-prefixed wins.
 */
export function extractAcs(description: string): string[] {
    const lines = description.split(/\r?\n/);
    const acPrefixed: string[] = [];
    const checkboxes: string[] = [];
    const numbered: string[] = [];

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const acMatch = /^AC[-:\s]?(\d+)[.:\s)]+(.+)$/i.exec(line);
        if (acMatch) {
            acPrefixed.push(acMatch[2].trim());
            continue;
        }

        const cbMatch = /^[-*]\s*\[[\sxX]\]\s*(.+)$/.exec(line);
        if (cbMatch) {
            checkboxes.push(cbMatch[1].trim());
            continue;
        }

        const numMatch = /^(\d+)[.):]\s*(.+)$/.exec(line);
        if (numMatch) {
            numbered.push(numMatch[2].trim());
        }
    }

    if (acPrefixed.length > 0) return acPrefixed;
    if (checkboxes.length > 0) return checkboxes;
    return numbered;
}

/** Prefer AC/checkbox/numbered lists; fall back to clause splitting. */
export function extractIntentCriteria(description: string): IntentCriterion[] {
    const acs = extractAcs(description);
    const parts = acs.length > 0 ? acs : splitScenarioClauses(description);
    return parts
        .map((text) => ({ text, tokens: significantTokens(text) }))
        .filter((c) => c.tokens.length > 0);
}

/**
 * Collect searchable literals from the draft: assertion matchers, getBy*
 * names, goto paths, and fill/click string args.
 */
export function extractDraftSignalTokens(body: string): Set<string> {
    const haystack: string[] = [];

    for (const match of body.matchAll(
        /\b(?:getBy(?:Role|Label|Text|Placeholder|TestId|Title|AltText)|locator)\s*\(\s*(['"`])([^'"`\n]+)\1/g,
    )) {
        haystack.push(match[2] ?? "");
    }
    // getByRole('button', { name: 'Sign in' })
    for (const match of body.matchAll(/\bname\s*:\s*(['"`])([^'"`\n]+)\1/g)) {
        haystack.push(match[2] ?? "");
    }
    for (const match of body.matchAll(
        /\b(?:to(?:HaveText|ContainText|HaveURL|HaveTitle|HaveValue|HaveAttribute)|toBeVisible|toBeEnabled)\s*\(\s*(?:\/([^/\n]+)\/[gimsuy]*|(['"`])([^'"`\n]+)\2)?/g,
    )) {
        haystack.push(match[1] ?? match[3] ?? "");
    }
    for (const match of body.matchAll(/\bpage\.goto\s*\(\s*(['"`])([^'"`\n]+)\1/g)) {
        haystack.push(match[2] ?? "");
    }
    for (const match of body.matchAll(
        /\.(?:fill|type|pressSequentially|selectOption)\s*\(\s*(['"`])([^'"`\n]+)\1/g,
    )) {
        haystack.push(match[2] ?? "");
    }

    // Also tokenize the whole body lightly so role names in comments/identifiers help.
    const tokens = new Set<string>();
    for (const chunk of haystack) {
        for (const token of significantTokens(chunk)) tokens.add(token);
    }
    for (const token of significantTokens(body.slice(0, 8000))) {
        // Keep body-wide tokens only when they look like domain nouns already
        // seen in string literals — avoid matching on import paths etc.
        if (haystack.some((h) => h.toLowerCase().includes(token))) tokens.add(token);
    }
    return tokens;
}

function criterionCovered(criterion: IntentCriterion, draftTokens: Set<string>): boolean {
    if (criterion.tokens.length === 0) return true;
    const hits = criterion.tokens.filter((token) => draftTokens.has(token));
    // Require at least half the significant tokens (min 1) to appear in the draft.
    const need = Math.max(1, Math.ceil(criterion.tokens.length * 0.5));
    return hits.length >= need;
}

/**
 * Flag scenario steps that have no matching assertion/action signal in the draft.
 */
export function assessIntentCoverage(
    description: string,
    body: string,
): IntentCoverageAssessment {
    const criteria = extractIntentCriteria(description);
    if (criteria.length === 0) {
        return { criteria: [], uncovered: [], reasons: [] };
    }

    const draftTokens = extractDraftSignalTokens(body);
    // A draft with no assertions at all cannot cover outcome criteria.
    const hasAssertion = /\bexpect\s*\(/.test(body);
    const uncovered = criteria.filter((criterion) => {
        if (!hasAssertion) return true;
        return !criterionCovered(criterion, draftTokens);
    });

    const reasons = uncovered.map(
        (criterion) =>
            `scenario step "${truncate(criterion.text, 80)}" has no matching assertion or action in the draft`,
    );

    return { criteria, uncovered, reasons };
}

function truncate(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max - 1)}…`;
}
