import {
    assertedScenarioTokens,
    changedAssertionRequirements,
} from "../testing/assertion-contract";
/**
 * Deterministic setup fixes applied before (and between) AI repair attempts.
 *
 * Many "failing specs" are wrong because of missing auth state or a hallucinated
 * origin — not because assertions need rewriting. Fixing those mechanically
 * keeps the LLM focused on real locator/flow bugs and stops unattended repair
 * from thrashing on setup.
 */

import { resolveAuthStorageStateRelativePath } from "../config/auth-state";
import { extractOrigins } from "../cover/evidence";
import {
    injectStorageState,
    resolveGotoPathsAgainstBaseUrl,
    rewriteAbsoluteGotosToRelative,
} from "../testing/spec-normalize";

export interface SetupFixResult {
    code: string;
    fixes: string[];
}

/**
 * Locators a Playwright timeout says it was still waiting for, newest first.
 * Covers both the action form (`waiting for getByRole(...)` in the call log)
 * and the assertion form (`Locator: getByText(...)`).
 */
export function extractPendingLocators(failureText: string): string[] {
    // Playwright colours its call log, and the escapes end up inside the
    // captured locator ("…level: 3 })\u001b[22m"), which then never matches
    // the same locator in source.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes by construction
    const plain = failureText.replace(/\u001b?\[\d{1,2}m/g, "");
    const found = new Set<string>();
    const patterns = [/-\s*waiting for\s+(.+)$/gim, /^\s*Locator:\s*(.+)$/gim];
    for (const pattern of patterns) {
        for (const match of plain.matchAll(pattern)) {
            const locator = match[1]?.trim();
            if (locator && locator.length < 200) found.add(locator);
        }
    }
    return [...found];
}

/**
 * Turn a bare "Test timeout of 30000ms exceeded" into instructions a fixer can
 * act on.
 *
 * A timeout is the least informative failure Playwright produces: no diff, no
 * assertion, just silence. Handed that alone, models reliably answer with the
 * spec unchanged — the repair then reports "no changes proposed" on a spec that
 * is still broken. Naming the locator that never resolved, and the two
 * explanations for it (wrong locator vs. never reached the page), is usually
 * the whole difference between a no-op and a fix.
 *
 * Returns null when the failure is not a timeout, so ordinary assertion
 * failures keep their existing, already-actionable evidence.
 */
export function describeTimeoutFocus(failureText: string): string | null {
    if (!/timeout|timed out/i.test(failureText)) return null;
    const locators = extractPendingLocators(failureText);

    const lines = [
        "[REPAIR FOCUS — the run timed out rather than failing an assertion]",
        locators.length > 0
            ? `The run was still waiting for: ${locators.map((l) => `\`${l}\``).join(", ")}. ` +
              "Nothing matched it before the deadline."
            : "An action or assertion never resolved before the deadline.",
        "There are only two explanations, and they need different fixes:",
        "1. The locator is wrong — the element exists under a different role, name, " +
            "label or test id. Replace it with one the captured page snapshots actually show.",
        "2. The test never reached the page — an earlier navigation landed somewhere " +
            "else (wrong path, wrong origin, an unhandled redirect or auth wall), so the " +
            "element was never going to be there. Check the entry URL before the locators.",
        "If the FIRST interaction in the spec is what timed out, prefer explanation 2.",
        "Do not raise timeouts, add waits, or weaken the assertion to make this pass.",
    ];
    return lines.join("\n");
}

/**
 * Locators the run PROVED match nothing: Playwright says it waited for them
 * and reports zero elements. Distinct from a plain timeout, where the element
 * may exist but never became visible.
 */
export function extractProvenAbsentLocators(failureText: string): string[] {
    if (!/element\(s\) not found|resolved to 0 element/i.test(failureText)) return [];
    return extractPendingLocators(failureText);
}

/**
 * Identity of a locator, ignoring the options that don't change what it
 * targets. `getByRole('heading', { name: 'X' })` and the same call with
 * `level: 3` or `exact: true` hunt for the same element, so a "fix" that only
 * adds options is re-asserting UI the run already proved absent.
 */
function locatorIdentities(text: string): Map<string, string> {
    const identities = new Map<string, string>();
    const add = (key: string, raw: string): void => {
        if (!identities.has(key)) identities.set(key, raw);
    };

    for (const match of text.matchAll(
        /getByRole\(\s*['"`]([\w-]+)['"`]\s*(?:,\s*\{([^}]*)\})?\s*\)?/g,
    )) {
        const role = match[1]?.toLowerCase() ?? "";
        const name = /name:\s*['"`]([^'"`]*)['"`]/.exec(match[2] ?? "")?.[1];
        add(`role:${role}|name:${(name ?? "").trim().toLowerCase()}`, match[0]);
    }
    for (const match of text.matchAll(
        /getBy(Text|TestId|Label|Placeholder|Title|AltText)\(\s*['"`]([^'"`]*)['"`]/g,
    )) {
        add(`${match[1]?.toLowerCase()}:${(match[2] ?? "").trim().toLowerCase()}`, match[0]);
    }
    return identities;
}

/**
 * Locators from `absentLocators` that a candidate fix still targets. Returned
 * as the raw call text from the fix so the message can quote what to remove.
 */
export function stillAssertsAbsentLocators(code: string, absentLocators: string[]): string[] {
    if (absentLocators.length === 0) return [];
    const absent = locatorIdentities(absentLocators.join("\n"));
    if (absent.size === 0) return [];
    const inCode = locatorIdentities(code);
    const repeated: string[] = [];
    for (const key of absent.keys()) {
        const raw = inCode.get(key);
        if (raw && !repeated.includes(raw)) repeated.push(raw);
    }
    return repeated;
}

/**
 * Retry guidance after a fix kept a locator the run proved absent. Models
 * "fix" a missing element by qualifying it (`level`, `exact`) or waiting
 * longer, which cannot work — the element is not on the page at all.
 */
export function describeReassertedAbsence(locators: string[]): string {
    return [
        "[PROVEN ABSENT — your previous fix is still asserting UI that does not exist]",
        `This run proved the page contains no match for: ${locators
            .map((locator) => `\`${locator}\``)
            .join(", ")}.`,
        "Adding options (level, exact, hasText), raising the timeout, or re-ordering the",
        "assertions cannot make an absent element appear.",
        "Either replace it with an element the captured evidence actually shows, or delete",
        "the assertion — if the scenario truly requires that element, the app is at fault",
        "and no test-side edit is correct.",
    ].join("\n");
}

/**
 * The literal expectations a scenario states: dollar amounts, percentages,
 * standalone numbers, and quoted phrases. These are ground truth for
 * verification — a test that passes without asserting them is a false green,
 * and a "fix" that drops them has adapted the test to a buggy app.
 */
export function scenarioExpectedTokens(scenario: string): string[] {
    const tokens = new Set<string>();
    const patterns: RegExp[] = [
        /\$\d+(?:\.\d{2})?/g,
        /\d+(?:\.\d+)?%/g,
        /(?:^|[\s,.;])(\d+)(?=$|[\s,.;])/g,
        /["'`]([^"'`]{2,})["'`]/g,
        // Identified things: a Title-Case phrase the scenario POINTS AT with
        // "is/named/called" ("the most expensive product is the Lift Standing
        // Desk"). Contextual mentions ("add the Pulse Ergonomic Mouse to the
        // cart") are not assertion targets and must not be required.
        /(?:is|are|named|called)\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,})/g,
    ];
    for (const pattern of patterns) {
        for (const match of scenario.matchAll(pattern)) {
            const token = (match[1] ?? match[0]).trim();
            if (token) tokens.add(token);
        }
    }
    return [...tokens];
}

/** Require expected scenario tokens in actual assertions, never in titles or setup. */
export function missingScenarioExpectations(code: string, scenario: string): string[] {
    const evidence = assertedScenarioTokens(code, { expectedValuesOnly: true });
    return scenarioExpectedTokens(scenario).filter(
        (token) =>
            !evidence.some((value) => {
                const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(
                    value,
                );
            }),
    );
}

/** Shared repair contract used by both standalone and graph callers. */
export function changedAssertedValues(originalCode: string, fixedCode: string): string[] {
    return changedAssertionRequirements(originalCode, fixedCode);
}

/**
 * Guidance when a repair dropped/changed an asserted value: the app may be the
 * broken side, so the test must keep asserting the original expectation.
 */
export function describeWeakenedAssertion(values: string[]): string {
    return [
        "[REPAIR REJECTED — the fix changed an asserted expectation]",
        `The corrected file no longer asserts: ${values.map((v) => `\`${v}\``).join(", ")}.`,
        "These values were the test's expectations, not page state. If the app",
        "renders something different, the APP is the likely bug — changing the",
        "assertion to match it turns a bug-catching test into a false green.",
        "Keep the original expectations. Fix only the test's mechanics (selectors,",
        "waits, navigation, interaction order). If you are certain the expectation",
        "itself is wrong, re-run with --allow-weaken.",
    ].join("\n");
}

/** The expected vs. actual values in an assertion-value failure. */
export interface ValueMismatch {
    expected: string;
    received: string;
}

/**
 * Pull an assertion-value mismatch out of a Playwright failure: the test
 * asserts one literal and the page renders another ("Expected: X / Received:
 * Y"). This is the signature of an app-side behavior difference — a
 * bug-catcher firing — not a locator or test-logic error a repair can patch,
 * because a "fix" that changes the assertion to match the page would be a
 * false green. Returns null when the failure is not a value mismatch.
 */
export function extractValueMismatch(failureText: string): ValueMismatch | null {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes by construction
    const plain = failureText.replace(/\u001b?\[\d{1,2}m/g, "");
    const expected = /Expected:\s*"?([^"\n]+)"?/i.exec(plain)?.[1]?.trim();
    const received = /Received:\s*"?([^"\n]+)"?/i.exec(plain)?.[1]?.trim();
    if (!expected || !received) return null;
    if (expected === received) return null;
    return { expected, received };
}

/**
 * Honest explanation for a repair that cannot fix an assertion-value failure:
 * the test asserts the correct value and the app renders something else, so no
 * test-side edit is correct. Used when the model returns no usable code for
 * such a failure, so the user sees the real reason instead of an opaque
 * "empty response".
 */
export function describeAssertionValueMismatch(mismatch: ValueMismatch): string {
    return (
        `The test asserts \`${mismatch.expected}\` but the app renders \`${mismatch.received}\` — ` +
        "an application-side behavior mismatch, not a locator or test-logic error. " +
        "The assertion was preserved: changing it to match the app would turn a " +
        "bug-catching test into a false green. Fix the app, or re-run with " +
        "--allow-weaken only if the expectation itself is wrong."
    );
}

/**
 * Escalation guidance after a fix dropped an expectation the scenario stated.
 * The app may be broken — the test must keep asserting what the user asked
 * for, or it stops being a bug-catcher.
 */
export function describeDroppedScenarioExpectation(tokens: string[]): string {
    return [
        "[REPAIR FOCUS — the fix dropped an expectation the scenario stated]",
        `The corrected file no longer asserts: ${tokens.map((t) => `\`${t}\``).join(", ")}.`,
        "These values came from the user's scenario, not from the page. If the app",
        "shows something else, the APP is wrong — changing the assertion to match",
        "the app turns a bug-catching test into a false green.",
        "Keep the scenario's expectations. Fix only the test's mechanics (selectors,",
        "waits, navigation). If the app genuinely contradicts the scenario, keep",
        "the assertion and report the app-side issue in one `// TODO:` line.",
    ].join("\n");
}

/**
 * A locator the failure evidence PROVED resolves on the page. The failure is
 * how the locator is used (strict-mode ambiguity), not its existence — so the
 * repair must keep it, never replace it. When Playwright printed unambiguous
 * alternatives for the same elements (`aka getByTestId(...)`), they are
 * carried too: switching to one of those is a valid disambiguation, not a
 * regression.
 */
export interface ProvenSelector {
    /** The locator call as Playwright printed it, e.g. `getByTestId("stat-active")`. */
    locator: string;
    /** The bare selector value — the token that must survive any fix. */
    value: string;
    /** Unambiguous alternatives Playwright suggested in the same error (`aka …`). */
    alternatives?: string[];
}

/**
 * Locators the run PROVED exist on the page: strict-mode violations, where
 * Playwright reports `resolved to N elements` with N ≥ 2. The mirror of
 * {@link extractProvenAbsentLocators} — "resolved to 0 elements" proves
 * absence; "resolved to 2 elements" proves presence (and ambiguity).
 */
export function extractProvenPresentSelectors(failureText: string): ProvenSelector[] {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes by construction
    const plain = failureText.replace(/\u001b?\[\d{1,2}m/g, "");
    const found = new Map<string, ProvenSelector>();
    for (const match of plain.matchAll(
        /strict mode violation:\s*(.+?)\s+resolved to (\d+) elements?:([\s\S]*?)(?=Error:|strict mode violation:|$)/gi,
    )) {
        const count = Number(match[2]);
        if (!Number.isFinite(count) || count < 2) continue;
        const locator = (match[1] ?? "").trim();
        const value = selectorValueOf(locator);
        if (!value) continue;
        const alternatives = [...(match[3] ?? "").matchAll(/aka\s+([^\n]+)/g)]
            .map((alt) => alt[1]?.trim().replace(/\s+$/, ""))
            .filter((alt): alt is string => !!alt && alt !== locator);
        if (!found.has(value)) {
            found.set(value, {
                locator,
                value,
                ...(alternatives.length > 0 ? { alternatives } : {}),
            });
        }
    }
    return [...found.values()];
}

/** Pull the bare selector value out of a locator call, e.g. `stat-active` from `getByTestId("stat-active")`. */
function selectorValueOf(locatorCall: string): string | undefined {
    const patterns = [
        /locator\(\s*['"`](.+?)['"`]/,
        /selector\s+['"`](.+?)['"`]/,
        /getBy(?:Role|Text|TestId|Label|Placeholder|Title|AltText)\(\s*['"`](.+?)['"`]/,
        /\[data-testid=['"`](.+?)['"`]\]/,
    ];
    for (const pattern of patterns) {
        const match = locatorCall.match(pattern);
        if (match?.[1]) return match[1];
    }
    return undefined;
}

/**
 * Parent-traversal locators (`locator('..')`, `xpath=..`, `xpath=ancestor::*`)
 * in a candidate fix. They are never stable: the fix breaks whenever the DOM
 * nests differently, and a text-anchored climb reaches the wrong container
 * (e.g. the title button instead of the row holding the status control).
 * Playwright locators compose — target the row/container directly.
 */
export function containsParentTraversal(code: string): string[] {
    const found = new Set<string>();
    const patterns = [
        /locator\(\s*['"]\.\.['"]\s*\)/g,
        /xpath=\s*['"]?\.\.\b/g,
        /xpath=\s*['"]?ancestor::/gi,
    ];
    for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) {
            found.add(match[0].trim());
        }
    }
    return [...found];
}

/**
 * Escalation guidance after a fix used parent traversal. The climb fails on
 * any nesting difference, and the source context names the real container —
 * use it directly.
 */
export function describeParentTraversal(locators: string[]): string {
    return [
        "[REPAIR FOCUS — the fix climbs the DOM with parent traversal]",
        `The corrected file uses ${locators.map((locator) => `\`${locator}\``).join(", ")}, ` +
            "which is never stable in Playwright.",
        "Parent traversal breaks whenever the DOM nests differently, and climbing " +
            "from a text node lands on the wrong container (a title button, not the " +
            "row that holds the status control).",
        "Target the container directly instead: use the row/card test id or role from " +
            "the source context above (e.g. a `task-row-*` test id), then locate the " +
            "control inside it.",
    ].join("\n");
}

/**
 * Escalation guidance after a fix removed a selector the run proved present.
 * Models misread a strict-mode violation as "wrong locator" and replace the
 * proven element with an invented one — which then fails for the opposite
 * reason (zero matches).
 */
export function describeRegressedSelector(selectors: ProvenSelector[]): string {
    return [
        "[PROVEN ON PAGE — your previous fix removed a selector the failure evidence proved exists]",
        `The failure evidence proved these locators resolve on the page (each matched ` +
            `multiple elements — strict-mode ambiguity, not absence): ${selectors
                .map((selector) => `\`${selector.locator}\``)
                .join(", ")}.`,
        "The element EXISTS — the failure is that the locator is ambiguous, not that it",
        "is wrong.",
        "Keep every one of these locators in the corrected file. Resolve the ambiguity",
        "with .first(), .nth(i), a scoped parent locator, or a more specific assertion.",
        "Do NOT replace them with invented locators and do NOT delete the assertion",
        "that uses them.",
    ].join("\n");
}

/**
 * Apply auth injection + relative-goto rewrites when evidence supports them.
 * Unknown origins (not in `knownOrigins`) that look like absolute navigations
 * are rewritten to `/` + pathname only when the origin is the project's
 * baseURL; otherwise they are left for the AI / origin lint to reject.
 */
export function applyRepairSetupFixes(
    code: string,
    projectPath: string,
    options: {
        baseURL: string | null;
        knownOrigins: ReadonlySet<string>;
        /** Failure text — used to decide whether auth injection is warranted. */
        failureText?: string;
    },
): SetupFixResult {
    let next = code;
    const fixes: string[] = [];

    const authRel = resolveAuthStorageStateRelativePath(projectPath);
    const failure = (options.failureText ?? "").toLowerCase();
    const looksLikeAuthWall =
        /login|sign[\s-]?in|auth|unauthorized|401|403|redirect|forbidden|storage.?state/.test(
            failure,
        );
    if (authRel && !/storageState/.test(next) && looksLikeAuthWall) {
        const injected = injectStorageState(next, authRel);
        if (injected !== next) {
            next = injected;
            fixes.push(`injected test.use({ storageState: ${JSON.stringify(authRel)} })`);
        }
    }

    if (options.baseURL) {
        const rewritten = rewriteAbsoluteGotosToRelative(next, options.baseURL);
        if (rewritten !== next) {
            next = rewritten;
            fixes.push(`rewrote absolute page.goto URLs to paths relative to ${options.baseURL}`);
        }
        // An app served under a sub-path makes `goto('/')` land on the origin
        // root instead of the app — a timeout that looks like a broken page.
        const rerooted = resolveGotoPathsAgainstBaseUrl(next, options.baseURL);
        if (rerooted !== next) {
            next = rerooted;
            fixes.push(
                `re-rooted page.goto paths under the baseURL path (${options.baseURL}) — a leading "/" resolves to the origin, not the app`,
            );
        }
    }

    // Surface unknown origins so callers can mention them; we don't rewrite
    // cross-origin gotos (that would hide the hallucination).
    const unknown = [...extractOrigins(next)].filter((origin) => !options.knownOrigins.has(origin));
    if (unknown.length > 0 && options.baseURL) {
        try {
            const baseOrigin = new URL(options.baseURL).origin;
            const stillUnknown = unknown.filter((origin) => origin !== baseOrigin);
            if (stillUnknown.length > 0) {
                fixes.push(`spec still navigates to unknown origin(s): ${stillUnknown.join(", ")}`);
            }
        } catch {
            /* ignore malformed baseURL */
        }
    }

    return { code: next, fixes };
}
