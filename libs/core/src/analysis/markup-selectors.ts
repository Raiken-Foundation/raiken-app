import * as path from "node:path";
import type { TemplateSelector } from "../types";
import { maskMatches } from "./masking";

/**
 * Read locator-shaped facts out of markup, whatever renders it.
 *
 * Raiken can only parse JS/TS, so the source side of a Django, Rails, Laravel or
 * Twig app used to contribute nothing to generation. The part of those repos that
 * actually matters for an E2E test is not their backend code — it is the test ids,
 * roles and labels sitting in their templates. This scanner is deliberately
 * regex-based rather than a real parser: it has to survive seven template
 * dialects interleaved with HTML, and it only ever reports literals.
 */

/** Template dialects scanned for selectors but never parsed as code. */
export const MARKUP_EXTENSIONS: readonly string[] = [
    ".html",
    ".htm",
    ".xhtml",
    ".jinja",
    ".jinja2",
    ".j2",
    ".njk",
    ".erb",
    ".haml",
    ".slim",
    ".blade.php",
    ".php",
    ".hbs",
    ".handlebars",
    ".mustache",
    ".ejs",
    ".twig",
    ".liquid",
    ".astro",
    ".razor",
    ".cshtml",
];

/** Attributes that yield a Playwright locator, and the locator kind each implies. */
const SELECTOR_ATTRIBUTES: Record<string, TemplateSelector["kind"]> = {
    "data-testid": "testId",
    "data-test-id": "testId",
    "data-test": "testId",
    "data-cy": "testId",
    "data-qa": "testId",
    "aria-label": "label",
    placeholder: "placeholder",
    role: "role",
};

/**
 * Comment syntaxes across the supported dialects. Masked before scanning so a
 * commented-out block cannot advertise a selector the page never renders.
 */
const COMMENT_PATTERNS: readonly RegExp[] = [
    /<!--[\s\S]*?-->/g, // HTML
    /\{#[\s\S]*?#\}/g, // Jinja / Nunjucks
    /\{\{--[\s\S]*?--\}\}/g, // Blade
    /\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g, // Django / Liquid
    /<%#[\s\S]*?%>/g, // ERB
    /\{!--[\s\S]*?--\}/g, // Handlebars-ish
];

/** Code islands inside markup — a JS string there is not an attribute. */
const CODE_BLOCKS: readonly RegExp[] = [
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
];

/** `name="value"` or `name='value'`, capturing enough of the name to spot bindings. */
const ATTRIBUTE = /([A-Za-z_@:[\]()#*.$-][\w@:[\]()#*.$-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Values computed at render time. A locator built from one of these would be a
 * fabrication, so they are dropped rather than reported.
 */
const INTERPOLATION = /\{\{|\}\}|\{%|%\}|<%|%>|\$\{|#\{|\{\$|@\{/;

/**
 * Attribute names that bind an expression instead of a literal: Vue `:x` and
 * `v-bind:x`, Angular `[x]`, Alpine `x-bind:x`, Svelte/Astro `x:y`, and event
 * handlers.
 */
const DYNAMIC_NAME = /^(?:[:@[]|v-bind:|x-bind:|v-on:|\(|\*|#)/i;

/**
 * A cap keeps one enormous template from crowding the prompt and the index.
 * `testId` first because it is the most actionable, then the name-bearing
 * attributes, then bare roles.
 */
const MAX_SELECTORS_PER_FILE = 60;
const KIND_PRIORITY: Record<TemplateSelector["kind"], number> = {
    testId: 0,
    label: 1,
    placeholder: 2,
    role: 3,
};

export function isMarkupFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return MARKUP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True for files whose markup is worth scanning even though they hold code too. */
export function hasScannableMarkup(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return isMarkupFile(filePath) || ext === ".vue" || ext === ".svelte";
}

/**
 * Line numbers for a forward-only walk over match offsets, so scanning a large
 * template stays linear instead of rescanning the prefix for every hit.
 */
function lineCounter(code: string): (index: number) => number {
    let cursor = 0;
    let line = 1;
    return (index) => {
        const target = Math.min(index, code.length);
        while (cursor < target) {
            if (code[cursor] === "\n") line++;
            cursor++;
        }
        return line;
    };
}

/**
 * Extract literal selectors from a markup string.
 *
 * The input is expected to be line-aligned with its file (see `masking`), so
 * reported line numbers point at real source lines.
 */
export function extractTemplateSelectors(markup: string): TemplateSelector[] {
    if (!markup.includes("=")) return [];

    let scannable = markup;
    for (const pattern of [...COMMENT_PATTERNS, ...CODE_BLOCKS]) {
        scannable = maskMatches(scannable, pattern);
    }

    const seen = new Set<string>();
    const found: TemplateSelector[] = [];
    const lineAt = lineCounter(scannable);

    for (const match of scannable.matchAll(ATTRIBUTE)) {
        const rawName = match[1] ?? "";
        if (DYNAMIC_NAME.test(rawName)) continue;

        const kind = SELECTOR_ATTRIBUTES[rawName.toLowerCase()];
        if (!kind) continue;

        const value = (match[2] ?? match[3] ?? "").trim();
        if (!value || value.length > 120) continue;
        if (INTERPOLATION.test(value)) continue;

        const dedupeKey = `${kind}\u0000${value}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const selector: TemplateSelector = {
            kind,
            value,
            line: lineAt(match.index ?? 0),
        };
        if (kind === "testId") selector.attribute = rawName.toLowerCase();
        found.push(selector);
    }

    if (found.length <= MAX_SELECTORS_PER_FILE) return found;

    return found
        .map((selector, order) => ({ selector, order }))
        .sort(
            (a, b) =>
                KIND_PRIORITY[a.selector.kind] - KIND_PRIORITY[b.selector.kind] ||
                a.order - b.order,
        )
        .slice(0, MAX_SELECTORS_PER_FILE)
        .map(({ selector }) => selector);
}

/**
 * Describe selectors for a prompt or an embedding.
 *
 * States the attribute a test id came from, because a project using `data-cy`
 * needs `testIdAttribute` configured before `getByTestId` will find it.
 */
export function describeTemplateSelectors(selectors: TemplateSelector[]): string {
    if (selectors.length === 0) return "";

    const byKind = new Map<string, string[]>();
    for (const selector of selectors) {
        const label =
            selector.kind === "testId"
                ? `test ids (${selector.attribute ?? "data-testid"})`
                : selector.kind === "label"
                  ? "aria-labels"
                  : selector.kind === "placeholder"
                    ? "placeholders"
                    : "roles";
        const bucket = byKind.get(label);
        if (bucket) bucket.push(selector.value);
        else byKind.set(label, [selector.value]);
    }

    return Array.from(byKind.entries())
        .map(([label, values]) => `${label}: ${values.join(", ")}`)
        .join("\n");
}
