/**
 * Pure plan heuristics — no @raiken/core dependency so unit tests can import
 * this without resolving workspace package aliases.
 */

export type PlanIntent = "explore" | "generateTests" | "explain" | "unknown";

const URL_RE = /https?:\/\/[^\s"'<>]+/i;
const GENERATE_RE = /\b(test|cover|generate|write|create|spec|e2e|playwright|assert|verify)\b/i;
const EXPLORE_RE = /\b(explore|crawl|discover|map|navigate|open|go to|visit)\b/i;
const EXPLAIN_RE = /\b(explain|what|how|why|where|show me|list|describe)\b/i;

export function guessIntent(prompt: string): PlanIntent {
    if (GENERATE_RE.test(prompt)) return "generateTests";
    if (EXPLORE_RE.test(prompt)) return "explore";
    if (EXPLAIN_RE.test(prompt)) return "explain";
    return "unknown";
}

export function extractUrl(prompt: string): string | null {
    const m = prompt.match(URL_RE);
    return m?.[0] ?? null;
}

export function matchRoutes(
    prompt: string,
    routes: Array<{ url: string; title: string | null }>,
): string[] {
    const lower = prompt.toLowerCase();
    const tokens = lower
        .split(/[^a-z0-9/-]+/)
        .filter((t) => t.length >= 3)
        .slice(0, 12);

    const scored = routes
        .map((r) => {
            const hay = `${r.url} ${r.title ?? ""}`.toLowerCase();
            let score = 0;
            for (const t of tokens) {
                if (hay.includes(t)) score += t.length;
            }
            return { url: r.url, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

    return scored.slice(0, 5).map((r) => r.url);
}
