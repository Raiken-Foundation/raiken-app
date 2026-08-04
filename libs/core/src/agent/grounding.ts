/**
 * Selector grounding: the single place that answers "does every locator in this
 * generated/repaired test correspond to something we actually captured?".
 *
 * Generation and repair both need this answer; generation used to compute a
 * weaker version inline and log it, and repair skipped it entirely. Findings are
 * returned as structured data rather than a log line so a caller can block a
 * save, feed them back into a regeneration, or show them to the user.
 *
 * Findings are split by what the capture can actually prove, because the two
 * classes deserve different treatment and conflating them either lets a broken
 * test through or refuses to write a correct one:
 *
 * - `contradictions` — the captured DOM shows this element with a *different*
 *   role than the locator claims (the `dialog` vs `alertdialog` class of bug).
 *   The element is real and the locator is provably wrong, so this blocks.
 * - `unverified` — the literal (accessible name, test id, label, placeholder)
 *   appears nowhere in the capture. Usually a guess, but not provably one: a
 *   validation error, a modal, or a page reached later in the flow exists only
 *   in a state we never captured. Reported to the user, not blocked, because
 *   refusing these would refuse most negative-path tests.
 * - `warnings` — `getByText` and raw CSS literals. Non-interactive text is
 *   legitimately absent from capture and CSS is too unstable to judge.
 *
 * A locator for a role outside capture coverage (headings, rows, alerts…) is
 * skipped entirely: absence proves nothing about elements we never enumerate.
 *
 * Capture is not the only admissible evidence. A test id that sits verbatim in
 * an indexed component template is real even when no captured page shows it —
 * state-gated UI (a filled cart, a validation error, a modal) never appears in
 * a crawl of resting pages. Callers may pass the project's `TemplateSelector`s
 * as a second evidence source; literals proven by source move to
 * `sourceGrounded` instead of `unverified`, so a correct draft is no longer
 * pushed through a regeneration pass that can only make it guessier.
 */

import type { TemplateSelector } from "../types";
import { normalizeSelector, parseSummaryElements } from "./graph/utils";

export type SelectorViolationKind =
    | "role_mismatch"
    | "unknown_role"
    | "unknown_name"
    | "unknown_test_id"
    | "unknown_label"
    | "unknown_placeholder"
    | "unknown_text"
    | "unknown_css";

export interface SelectorViolation {
    /** The locator call as written in the test, e.g. `getByRole('dialog', …)`. */
    locator: string;
    kind: SelectorViolationKind;
    /** What the capture says about this locator, in reviewer-readable terms. */
    reason: string;
    /** A grounded locator that would work instead, when the capture implies one. */
    suggestion?: string;
}

export interface GroundingReport {
    /** True when nothing at all was flagged. */
    ok: boolean;
    /** Locators the captured DOM proves wrong. These must block save and run. */
    contradictions: SelectorViolation[];
    /** Locators the capture can neither confirm nor refute. Report, don't block. */
    unverified: SelectorViolation[];
    /** Looser misses (text/CSS literals) kept advisory to avoid false positives. */
    warnings: SelectorViolation[];
    /**
     * Locators absent from every captured page but proven by source markup
     * (a literal `data-testid`, `aria-label`, `placeholder` or `role` in an
     * indexed template). Valid targets for state the crawl never reached;
     * informational only.
     */
    sourceGrounded: SelectorViolation[];
    /**
     * False when the summaries carried no structured elements to compare
     * against (no capture happened, or a caller passed prose). Callers must not
     * act on an unenforceable report — there is nothing to compare with.
     */
    enforceable: boolean;
}

/** Container roles: a modal is only comparable with another modal. */
const LANDMARK_ROLES = new Set(["dialog", "alertdialog"]);

/**
 * Roles a locator targets for interaction. A role_mismatch is only sound when
 * the same-name captured element is the same KIND of thing: a `dialog`
 * locator is contradicted by an `alertdialog` (both interactive modals), but a
 * `combobox` locator is NOT contradicted by a table's `columnheader` that
 * happens to share its label — the two elements can genuinely coexist (a form
 * select labeled "Project" beside a table column named "Project"), and the
 * passive element is not what the test meant. Same-kind candidates are
 * required so a wrong-role finding never suggests replacing an interactive
 * control with a structural one.
 */
const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "tab",
    "dialog",
    "alertdialog",
    "searchbox",
    "spinbutton",
    "listbox",
    "menuitem",
    "option",
]);

/**
 * Roles that DOM capture enumerates for any visible page state (see
 * `BrowserSession.extractRawFromFrame` and `computeRole`). Only these can be
 * judged: for any other role, absence from the capture proves nothing.
 *
 * `menuitem` and `option` are deliberately excluded even though the extractor
 * queries them — both normally live inside a collapsed menu or a native
 * `<select>`, so they are absent from capture while still being valid targets.
 */
const CAPTURED_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "tab",
    "dialog",
    "alertdialog",
]);

const LOCATOR_METHOD_RE =
    /\b(getByRole|getByTestId|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|locator)\s*\(/g;

interface LocatorCall {
    method: string;
    /** Reconstructed call text, used verbatim in violation messages. */
    raw: string;
    /** Raw argument text between the parentheses. */
    args: string;
}

type LiteralArg = { kind: "string"; value: string } | { kind: "regex"; value: RegExp };

interface CapturedIndex {
    elements: Array<{ role: string; name: string }>;
    roles: Set<string>;
    /** Lowercased, whitespace-collapsed text of everything captured. */
    text: string;
}

/** Literal selector facts read out of indexed source markup, bucketed by kind. */
interface SourceIndex {
    testIds: Set<string>;
    labels: Set<string>;
    placeholders: Set<string>;
    roles: Set<string>;
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Find the index of the `)` that closes the `(` at `openIndex`, ignoring
 * parentheses inside string literals so `getByText('a (b)')` doesn't confuse
 * the scan. Returns -1 when the call is unbalanced (e.g. truncated code), in
 * which case the caller skips the locator instead of reporting it.
 */
function findClosingParen(code: string, openIndex: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = openIndex; i < code.length; i++) {
        const ch = code[i];
        if (quote) {
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function extractLocatorCalls(code: string): LocatorCall[] {
    const calls: LocatorCall[] = [];
    LOCATOR_METHOD_RE.lastIndex = 0;
    let match = LOCATOR_METHOD_RE.exec(code);
    while (match) {
        const open = match.index + match[0].length - 1;
        const close = findClosingParen(code, open);
        if (close > open) {
            const args = code.slice(open + 1, close);
            calls.push({ method: match[1], raw: `${match[1]}(${args})`, args });
        }
        match = LOCATOR_METHOD_RE.exec(code);
    }
    return calls;
}

/** Read a string or regex literal starting at `from`, skipping whitespace. */
function readLiteral(args: string, from: number): LiteralArg | null {
    let i = from;
    while (i < args.length && /\s/.test(args[i])) i++;
    const ch = args[i];
    if (ch === "'" || ch === '"' || ch === "`") {
        let value = "";
        for (let j = i + 1; j < args.length; j++) {
            const c = args[j];
            if (c === "\\") {
                value += args[j + 1] ?? "";
                j++;
                continue;
            }
            if (c === ch) return { kind: "string", value };
            value += c;
        }
        return null;
    }
    if (ch === "/") {
        let pattern = "";
        for (let j = i + 1; j < args.length; j++) {
            const c = args[j];
            if (c === "\\") {
                pattern += c + (args[j + 1] ?? "");
                j++;
                continue;
            }
            if (c === "/") {
                const flags = (args.slice(j + 1).match(/^[dgimsuy]*/) || [""])[0];
                try {
                    return { kind: "regex", value: new RegExp(pattern, flags) };
                } catch {
                    return null;
                }
            }
            pattern += c;
        }
        return null;
    }
    // Template/variable/expression argument — not statically checkable.
    return null;
}

function readNameOption(args: string): LiteralArg | null {
    const match = args.match(/\bname\s*:\s*/);
    if (!match || match.index === undefined) return null;
    return readLiteral(args, match.index + match[0].length);
}

function literalMatches(target: LiteralArg, candidate: string, exact: boolean): boolean {
    if (target.kind === "regex") return target.value.test(candidate);
    const a = normalizeText(candidate);
    const b = normalizeText(target.value);
    if (!b) return true;
    return exact ? a === b : a.includes(b);
}

/** Playwright's default name matching is substring + case-insensitive. */
function isExactOption(args: string): boolean {
    return /\bexact\s*:\s*true\b/.test(args);
}

/** A quoted literal is grounded if it occurs anywhere in what we captured. */
function appearsInCapture(index: CapturedIndex, literal: LiteralArg): boolean {
    if (literal.kind === "regex") {
        // A pattern can't be searched for literally; accept it as long as some
        // captured element name matches, otherwise leave it to the role checks.
        return index.elements.some((el) => literal.value.test(el.name));
    }
    const needle = normalizeText(literal.value);
    return needle.length === 0 || index.text.includes(needle);
}

/** Every `Selector:`/`Selectors:` line, which also covers the form-field block. */
function collectSelectorLines(summary: string): string[] {
    const selectors: string[] = [];
    for (const line of summary.split("\n")) {
        const match = line.trim().match(/^Selectors?:\s+(.+)$/);
        if (!match) continue;
        for (const part of match[1].split(" | ")) {
            const selector = part.trim();
            if (selector) selectors.push(selector);
        }
    }
    return selectors;
}

/**
 * ARIA roles accepted from a Playwright `ariaSnapshot()` line. The gate exists
 * because the parser is a line regex, not a YAML parser: a prose bullet like
 * `- some note` would otherwise register a bogus role "some".
 */
const ARIA_SNAPSHOT_ROLES = new Set([
    ...CAPTURED_ROLES,
    "heading",
    "list",
    "listitem",
    "table",
    "row",
    "cell",
    "columnheader",
    "rowheader",
    "img",
    "text",
    "paragraph",
    "navigation",
    "banner",
    "contentinfo",
    "main",
    "region",
    "form",
    "searchbox",
    "menuitem",
    "menu",
    "option",
    "listbox",
    "group",
    "article",
    "alert",
    "status",
    "separator",
    "spinbutton",
    "progressbar",
]);

const ARIA_SNAPSHOT_LINE = /^-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*[:[]?/;

/**
 * Parse the YAML-ish output of Playwright's `page.ariaSnapshot()` — the format
 * `raiken discover` persists for every crawled page (`- button "Add to cart"`).
 * Without this, knowledge produced by the crawler carries no structured
 * elements and grounding degrades to advisory for every non-agent caller.
 */
function parseAriaSnapshotElements(summary: string): Array<{ role: string; name: string }> {
    const elements: Array<{ role: string; name: string }> = [];
    for (const raw of summary.split("\n")) {
        const match = ARIA_SNAPSHOT_LINE.exec(raw.trim());
        if (!match) continue;
        const role = match[1];
        if (!ARIA_SNAPSHOT_ROLES.has(role)) continue;
        elements.push({ role, name: (match[2] ?? "").replace(/\\(.)/g, "$1") });
    }
    return elements;
}

function buildCapturedIndex(summaries: string[]): CapturedIndex {
    const elements: Array<{ role: string; name: string }> = [];
    const roles = new Set<string>();
    const textParts: string[] = [];

    for (const summary of summaries) {
        if (!summary) continue;
        textParts.push(summary);
        const parsed = parseSummaryElements(summary);
        if (parsed.length > 0) {
            for (const el of parsed) {
                const role = el.role.trim().toLowerCase();
                elements.push({ role, name: el.name });
                roles.add(role);
                for (const selector of el.selectors) {
                    const normalized = normalizeSelector(selector);
                    if (normalized) textParts.push(normalized);
                }
            }
        } else {
            // Not the agent's summary format — try the crawler's ariaSnapshot.
            for (const el of parseAriaSnapshotElements(summary)) {
                elements.push({ role: el.role, name: el.name });
                roles.add(el.role);
            }
        }
        // Form-field selectors carry test ids / labels / placeholders that the
        // interactive-element lines may not repeat.
        textParts.push(...collectSelectorLines(summary));
    }

    return {
        elements,
        roles,
        text: normalizeText(textParts.join("\n")),
    };
}

function buildSourceIndex(selectors: readonly TemplateSelector[]): SourceIndex {
    const index: SourceIndex = {
        testIds: new Set(),
        labels: new Set(),
        placeholders: new Set(),
        roles: new Set(),
    };
    for (const selector of selectors) {
        const value = normalizeText(selector.value);
        if (!value) continue;
        switch (selector.kind) {
            case "testId":
                index.testIds.add(value);
                break;
            case "label":
                index.labels.add(value);
                break;
            case "placeholder":
                index.placeholders.add(value);
                break;
            case "role":
                index.roles.add(value);
                break;
        }
    }
    return index;
}

/** Does source markup contain this literal, for the bucket a locator kind implies? */
function sourceHasLiteral(
    source: SourceIndex,
    bucket: keyof SourceIndex,
    literal: LiteralArg,
): boolean {
    if (literal.kind === "regex") {
        for (const value of source[bucket]) {
            if (literal.value.test(value)) return true;
        }
        return false;
    }
    return source[bucket].has(normalizeText(literal.value));
}

const EMPTY_SOURCE_INDEX: SourceIndex = {
    testIds: new Set(),
    labels: new Set(),
    placeholders: new Set(),
    roles: new Set(),
};

function quote(value: string): string {
    return `'${value.replace(/'/g, "\\'")}'`;
}

function describeLiteral(literal: LiteralArg): string {
    return literal.kind === "regex" ? String(literal.value) : quote(literal.value);
}

function checkRoleLocator(
    call: LocatorCall,
    index: CapturedIndex,
    source: SourceIndex,
    contradictions: SelectorViolation[],
    unverified: SelectorViolation[],
    sourceGrounded: SelectorViolation[],
): void {
    const roleArg = readLiteral(call.args, 0);
    if (!roleArg || roleArg.kind !== "string") return;
    const role = normalizeText(roleArg.value);
    if (!CAPTURED_ROLES.has(role)) return;

    const name = readNameOption(call.args);
    if (!name) {
        // Nameless role locator (often a scope, e.g. `.getByRole('dialog')`).
        // Only the role itself can be judged.
        if (!index.roles.has(role)) {
            if (source.roles.has(role)) {
                sourceGrounded.push({
                    locator: call.raw,
                    kind: "unknown_role",
                    reason: `role "${role}" was not captured on any visited page but is declared in source markup`,
                });
                return;
            }
            unverified.push({
                locator: call.raw,
                kind: "unknown_role",
                reason: `no element with role "${role}" was captured on any visited page`,
            });
        }
        return;
    }

    const exact = isExactOption(call.args);
    if (index.elements.some((el) => el.role === role && literalMatches(name, el.name, exact))) {
        return;
    }

    // The element exists under another role: real element, wrong role. The
    // candidate must be the same kind of thing — a modal named "Delete
    // workspace?" explains a `dialog` locator, but the *button* that opens it
    // does not, and suggesting the trigger would send the test somewhere else.
    // Prefer an exactly-named candidate so the suggestion points at the control
    // the test meant ("Delete") rather than the first substring match that
    // happens to contain it ("Delete project").
    const wantsLandmark = LANDMARK_ROLES.has(role);
    const candidates = index.elements.filter(
        (el) =>
            el.role !== role &&
            LANDMARK_ROLES.has(el.role) === wantsLandmark &&
            // Only an interactive candidate can explain a locator that targets
            // an interactive control. A structural element (columnheader,
            // heading, cell, …) sharing the name is a different element, not a
            // wrong-role version of the intended one.
            INTERACTIVE_ROLES.has(el.role) === INTERACTIVE_ROLES.has(role) &&
            literalMatches(name, el.name, exact),
    );
    const mismatched =
        candidates.find(
            (el) => name.kind === "string" && normalizeText(el.name) === normalizeText(name.value),
        ) ?? candidates[0];
    if (mismatched) {
        contradictions.push({
            locator: call.raw,
            kind: "role_mismatch",
            reason: `the captured DOM exposes this element with role "${mismatched.role}", not "${role}"`,
            suggestion: `getByRole(${quote(mismatched.role)}, { name: ${describeLiteral(name)} })`,
        });
        return;
    }

    if (!appearsInCapture(index, name)) {
        // An `aria-label` in source markup supplies exactly this accessible
        // name, so a literal match there proves the element exists in some
        // renderable state even though no captured page showed it.
        if (sourceHasLiteral(source, "labels", name)) {
            sourceGrounded.push({
                locator: call.raw,
                kind: "unknown_name",
                reason: `accessible name ${describeLiteral(name)} was not captured but matches an aria-label in source markup`,
            });
            return;
        }
        unverified.push({
            locator: call.raw,
            kind: "unknown_name",
            reason: `no captured element has the accessible name ${describeLiteral(name)}`,
        });
    }
}

function checkLiteralLocator(
    call: LocatorCall,
    index: CapturedIndex,
    source: SourceIndex,
    bucket: keyof SourceIndex,
    kind: SelectorViolationKind,
    label: string,
    unverified: SelectorViolation[],
    sourceGrounded: SelectorViolation[],
): void {
    const literal = readLiteral(call.args, 0);
    // A pattern argument can't be searched for in captured text, and the
    // attribute it targets (label/placeholder/test id) isn't indexed per
    // element, so there is nothing to compare.
    if (!literal || literal.kind !== "string") return;
    if (appearsInCapture(index, literal)) return;
    if (sourceHasLiteral(source, bucket, literal)) {
        sourceGrounded.push({
            locator: call.raw,
            kind,
            reason: `${label} ${describeLiteral(literal)} was not captured on any visited page but exists in source markup`,
        });
        return;
    }
    unverified.push({
        locator: call.raw,
        kind,
        reason: `no captured element has the ${label} ${describeLiteral(literal)}`,
    });
}

function checkAdvisoryLocator(
    call: LocatorCall,
    index: CapturedIndex,
    kind: SelectorViolationKind,
    label: string,
    warnings: SelectorViolation[],
): void {
    const literal = readLiteral(call.args, 0);
    if (!literal || literal.kind !== "string") return;
    // Short literals match too much captured text to say anything useful.
    if (literal.value.trim().length <= 2) return;
    if (appearsInCapture(index, literal)) return;
    warnings.push({
        locator: call.raw,
        kind,
        reason: `the ${label} ${quote(literal.value)} was not seen in any captured page`,
    });
}

/**
 * Compare every locator in `testCode` against the captured page context
 * (live DOM summary plus every visited page summary). `sourceSelectors` —
 * literal selector facts from indexed markup (see `extractTemplateSelectors`)
 * — act as a second evidence source: a literal absent from capture but present
 * in source is reported under `sourceGrounded` instead of `unverified`.
 */
export function validateSelectorGrounding(
    testCode: string,
    summaries: string[],
    sourceSelectors?: readonly TemplateSelector[],
): GroundingReport {
    const index = buildCapturedIndex(
        summaries.filter((s) => typeof s === "string" && s.length > 0),
    );
    const source = sourceSelectors?.length ? buildSourceIndex(sourceSelectors) : EMPTY_SOURCE_INDEX;
    const contradictions: SelectorViolation[] = [];
    const unverified: SelectorViolation[] = [];
    const warnings: SelectorViolation[] = [];
    const sourceGrounded: SelectorViolation[] = [];
    const enforceable = index.elements.length > 0;

    if (!testCode.trim()) {
        return { ok: true, contradictions, unverified, warnings, sourceGrounded, enforceable };
    }

    for (const call of extractLocatorCalls(testCode)) {
        switch (call.method) {
            case "getByRole":
                if (enforceable) {
                    checkRoleLocator(
                        call,
                        index,
                        source,
                        contradictions,
                        unverified,
                        sourceGrounded,
                    );
                }
                break;
            case "getByTestId":
                if (enforceable) {
                    checkLiteralLocator(
                        call,
                        index,
                        source,
                        "testIds",
                        "unknown_test_id",
                        "test id",
                        unverified,
                        sourceGrounded,
                    );
                }
                break;
            case "getByLabel":
                if (enforceable) {
                    checkLiteralLocator(
                        call,
                        index,
                        source,
                        "labels",
                        "unknown_label",
                        "label",
                        unverified,
                        sourceGrounded,
                    );
                }
                break;
            case "getByPlaceholder":
                if (enforceable) {
                    checkLiteralLocator(
                        call,
                        index,
                        source,
                        "placeholders",
                        "unknown_placeholder",
                        "placeholder",
                        unverified,
                        sourceGrounded,
                    );
                }
                break;
            case "getByText":
            case "getByAltText":
            case "getByTitle":
                checkAdvisoryLocator(call, index, "unknown_text", "text", warnings);
                break;
            case "locator":
                checkAdvisoryLocator(call, index, "unknown_css", "selector", warnings);
                break;
        }
    }

    return {
        ok: contradictions.length === 0 && unverified.length === 0 && warnings.length === 0,
        contradictions,
        unverified,
        warnings,
        sourceGrounded,
        enforceable,
    };
}

/**
 * Flatten the template selectors of gathered context files into one evidence
 * list — the shape `validateSelectorGrounding` expects. Accepts anything with
 * an optional `templateSelectors` field so `ContextData.files` works directly.
 */
export function collectSourceSelectors(
    files: ReadonlyArray<{ templateSelectors?: TemplateSelector[] }> | undefined | null,
): TemplateSelector[] {
    if (!files?.length) return [];
    const selectors: TemplateSelector[] = [];
    for (const file of files) {
        if (file.templateSelectors?.length) selectors.push(...file.templateSelectors);
    }
    return selectors;
}

/** One line per violation, used in prompts, summaries, and CLI output. */
export function describeGroundingViolations(violations: SelectorViolation[]): string[] {
    return violations.map((violation) => {
        const fix = violation.suggestion ? ` Use ${violation.suggestion} instead.` : "";
        return `${violation.locator} — ${violation.reason}.${fix}`;
    });
}

/**
 * Prompt block that feeds findings back to the model for one corrective pass.
 * Contradictions are stated as hard errors; unverified locators are asked about
 * rather than banned, since some of them are legitimately absent from capture.
 */
export function formatGroundingCorrection(report: GroundingReport): string {
    const lines = ["[GROUNDING VIOLATIONS — the previous draft was not accepted]"];
    if (report.contradictions.length > 0) {
        lines.push(
            "These locators are provably wrong — the element exists under a different role:",
            ...describeGroundingViolations(report.contradictions).map((line) => `- ${line}`),
            "",
        );
    }
    if (report.unverified.length > 0) {
        lines.push(
            "These locators match nothing in the captured DOM. Replace each one with a captured",
            "locator, or drop the step if the state it needs was never captured:",
            ...describeGroundingViolations(report.unverified).map((line) => `- ${line}`),
            "",
        );
    }
    lines.push(
        "Rewrite the complete test using ONLY locators that appear in the captured DOM",
        "sections above. Do not keep a locator by adding a wait, a retry, or a comment.",
    );
    return lines.join("\n");
}

/**
 * Corrective pass for a draft whose assertions only ever check for absence.
 *
 * This is what a model produces when it cannot find the thing it was asked to
 * verify: asked to assert some text is visible, it quietly writes
 * `toBeHidden()` / `.not.toBeVisible()` and the run goes green having checked
 * the opposite of the request. The absence also holds on a blank page or a
 * failed navigation, so the test proves nothing either way.
 */
export function formatAssertionPolarityCorrection(userPrompt: string, reason: string): string {
    return [
        "[ASSERTION POLARITY — the previous draft was not accepted]",
        reason,
        "",
        `The request was: ${userPrompt}`,
        "",
        "Write the assertion the request actually asks for, in its original polarity.",
        "If it asks for something to be visible/present, assert toBeVisible() — do NOT",
        "substitute toBeHidden(), .not.toBeVisible(), or toHaveCount(0) because the page",
        "evidence doesn't show it. A test that fails against the real app is the correct",
        "answer there; an inverted assertion reports a false pass. When you cannot confirm",
        "the element from the evidence, keep the requested assertion and mark the line with",
        "a `// TODO:` naming what could not be confirmed.",
    ].join("\n");
}

/**
 * Human-facing explanation shown when a draft is rejected for good. Only
 * contradictions get here — those are the findings the capture proves.
 */
export function formatGroundingRejection(contradictions: SelectorViolation[]): string {
    const listed = describeGroundingViolations(contradictions)
        .slice(0, 5)
        .map((line) => `- ${line}`)
        .join("\n");
    const extra =
        contradictions.length > 5
            ? `\n- ...and ${contradictions.length - 5} more ungrounded locator(s)`
            : "";
    return [
        `Test generation was rejected: ${contradictions.length} locator(s) contradict the captured DOM, so the test would fail for the wrong reason.`,
        "",
        listed + extra,
        "",
        "Fix the roles above (or explore the missing state so it can be captured), then generate again.",
    ].join("\n");
}
