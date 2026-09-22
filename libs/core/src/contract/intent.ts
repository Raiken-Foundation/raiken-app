import { ContractStore } from "./store";
import type { IntentFact } from "./types";

/**
 * Intent import: structured AC files and tickets become intent facts.
 *
 * The file format is deliberately the simplest thing a team can drop in a
 * repo or paste from a ticket — markdown checkboxes or plain lines, each one
 * a requirement. Ticket import reuses the provider registry; AC extraction
 * from free-form bodies falls back to the same line heuristics (an LLM pass
 * can refine later — never required).
 */

export interface ParsedRequirement {
    text: string;
    routeHint: string | null;
    neverRegress: boolean;
}

export interface ImportResult {
    imported: number;
    skipped: number;
    requirements: ParsedRequirement[];
}

/** Parse a requirements file: `- [ ] text`, `- text`, `AC-3: text`, or `N. text`. */
export function parseRequirementsFile(raw: string): ParsedRequirement[] {
    const out: ParsedRequirement[] = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const checkbox = trimmed.match(/^[-*]\s+\[[ xX]\]\s+(.*)$/);
        const bullet = trimmed.match(/^[-*]\s+(.*)$/);
        const ac = trimmed.match(/^AC[-\s]?\d+\s*[:.]?\s+(.*)$/i);
        const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
        const text = (checkbox ?? ac ?? bullet ?? numbered)?.[1]?.trim();
        if (!text || text.length < 4) continue;
        const neverRegress = /\b(never|regress|must not (break|recur)|no longer)\b/i.test(text);
        const route = extractRouteHint(text);
        out.push({ text, routeHint: route, neverRegress });
    }
    return out;
}

/** Pull a leading route reference ("/checkout", "#/stats") out of a requirement. */
export function extractRouteHint(text: string): string | null {
    const m = text.match(/(\/[a-z0-9\-_/]{2,40}|#\/[a-z0-9\-_/]{2,40})/i);
    return m ? m[1] : null;
}

export function importRequirements(
    store: ContractStore,
    source: IntentFact["source"],
    requirements: ParsedRequirement[],
    ticket?: {
        id: string;
        provider: string;
        severity?: string | null;
        url?: string | null;
    },
): ImportResult {
    let imported = 0;
    let skipped = 0;
    for (const req of requirements) {
        if (requirementsTooSimilar(store, req.text)) {
            skipped++;
            continue;
        }
        const res = store.upsertIntentFact({
            requirementText: req.text,
            routeHint: req.routeHint,
            ticketId: ticket?.id ?? null,
            ticketProvider: ticket?.provider ?? null,
            ticketSeverity: ticket?.severity ?? null,
            ticketUrl: ticket?.url ?? null,
            neverRegress: req.neverRegress,
            status: "uncovered",
            matchedFactId: null,
            source,
            importedAt: Date.now(),
        });
        if (res.id && ticket) {
            store.addTrace(res.id, "intent", "ticket", ticket.id);
        }
        imported++;
    }
    return { imported, skipped, requirements };
}

/** Skip near-duplicate requirements (same normalized text already imported). */
function requirementsTooSimilar(store: ContractStore, text: string): boolean {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const want = norm(text);
    return store.listIntentFacts().some((i) => norm(i.requirementText) === want);
}

/** Extract requirements from a ticket body (checkboxes first, then sentences). */
export function parseTicketRequirements(title: string, body: string): ParsedRequirement[] {
    const structured = parseRequirementsFile(body);
    if (structured.length > 0) {
        return structured.map((r) => ({ ...r, text: r.text }));
    }
    // Free-form body: accept criteria-ish sentences, capped.
    const sentences = body
        .split(/[\n.]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 15 && /\b(must|should|shows?|displays?|allows?|requires?|accepts?)\b/i.test(s))
        .slice(0, 6);
    return sentences.map((text) => ({
        text,
        routeHint: extractRouteHint(text),
        neverRegress: /\b(bug|regression|no longer|broke)\b/i.test(`${title} ${text}`),
    }));
}
