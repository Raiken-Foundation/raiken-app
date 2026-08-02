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
