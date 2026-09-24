/**
 * Type definitions and formatting utilities for DOM capture.
 *
 * Element collection and selector construction live in the browser session
 * decomposition modules (`session/selector-utils`, `session/dom-snapshot-builder`).
 * This module holds only the shared interfaces and the text-formatting layer
 * consumed by the agent.
 */

export interface AccessibilityNode {
    role: string;
    name?: string;
    value?: string;
    description?: string;
    checked?: boolean | "mixed";
    pressed?: boolean | "mixed";
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    level?: number;
    valuemin?: number;
    valuemax?: number;
    valuetext?: string;
    children?: AccessibilityNode[];
}

export interface DOMContext {
    url: string;
    title: string;
    accessibilityTree: AccessibilityNode | null;
    timestamp: number;
    _prerequisites?: string[];
    interactiveElements: InteractiveElement[];
    formFields: FormField[];
    /**
     * Observed runtime behavior of the page (load timing, TTFB, whether the
     * network settled). Surfaced to the test generator so it can pick
     * realistic waits/timeouts instead of guessing. Optional because it is
     * only available on pages reached via a real navigation.
     */
    performance?: PagePerformance;
}

/**
 * Runtime performance signals observed for a page. All durations are in
 * milliseconds. Fields are optional because the browser exposes different
 * subsets depending on how/when the page was reached (e.g. the `load` event
 * may not have fired yet when we capture on `domcontentloaded`).
 */
export interface PagePerformance {
    /** Wall-clock time we measured for the last navigation (goto → settled). */
    navigationMs?: number;
    /** Navigation Timing: DOMContentLoaded relative to navigation start. */
    domContentLoadedMs?: number;
    /** Navigation Timing: load event relative to navigation start. */
    loadEventMs?: number;
    /** Time to first byte (responseStart − requestStart). */
    ttfbMs?: number;
    /** Whether the network reached idle within our capture window. */
    networkIdle?: boolean;
    /** Slowest network responses observed during the last navigation. */
    slowResponses?: Array<{ url: string; status: number; durationMs: number }>;
}

export interface InteractiveElement {
    tagName: string;
    role?: string;
    name?: string;
    text?: string;
    testId?: string;
    type?: string;
    ariaLabel?: string;
    htmlName?: string;
    htmlId?: string;
    href?: string;
    placeholder?: string;
    suggestedSelectors: string[];
}

export interface FormField {
    name: string;
    type: string;
    label?: string;
    placeholder?: string;
    required: boolean;
    id?: string;
    suggestedSelector: string;
}

function formatAccessibilityTree(node: AccessibilityNode | null, indent = 0): string {
    if (!node) return "(empty tree)";

    const lines: string[] = [];
    const prefix = "  ".repeat(indent);

    let desc = `${prefix}• ${node.role}`;
    if (node.name) desc += `: "${node.name}"`;
    if (node.value) desc += ` [value: "${node.value}"]`;
    if (node.checked !== undefined) desc += ` [checked: ${node.checked}]`;
    if (node.selected) desc += ` [selected]`;
    if (node.disabled) desc += ` [disabled]`;
    if (node.expanded !== undefined) desc += ` [expanded: ${node.expanded}]`;

    lines.push(desc);

    if (node.children && indent < 4) {
        for (const child of node.children) {
            lines.push(formatAccessibilityTree(child, indent + 1));
        }
    } else if (node.children && node.children.length > 0) {
        lines.push(`${prefix}  ... (${node.children.length} more children)`);
    }

    return lines.join("\n");
}

/**
 * Turn raw performance numbers into human-readable lines plus a concrete,
 * behavior-derived hint about how the generated test should wait. The point
 * is to let the model calibrate timeouts to what the page actually did rather
 * than defaulting to Playwright's stock values (which are often too tight for
 * a slow page and too loose for a snappy one).
 */
function formatPageBehavior(perf: PagePerformance | undefined): string[] {
    if (!perf) return [];

    const lines: string[] = [];
    const ms = (n: number) => `${Math.round(n)}ms`;

    // The most representative "how long did this page take" number we have.
    const settleMs = perf.navigationMs ?? perf.loadEventMs ?? perf.domContentLoadedMs ?? undefined;

    if (perf.navigationMs !== undefined)
        lines.push(`- Navigation (wall clock): ${ms(perf.navigationMs)}`);
    if (perf.ttfbMs !== undefined) lines.push(`- Time to first byte: ${ms(perf.ttfbMs)}`);
    if (perf.domContentLoadedMs !== undefined)
        lines.push(`- DOMContentLoaded: ${ms(perf.domContentLoadedMs)}`);
    if (perf.loadEventMs !== undefined) lines.push(`- Load event: ${ms(perf.loadEventMs)}`);
    if (perf.networkIdle !== undefined)
        lines.push(`- Network reached idle: ${perf.networkIdle ? "yes" : "no (still active)"}`);

    if (perf.slowResponses && perf.slowResponses.length > 0) {
        lines.push("- Slowest responses:");
        for (const r of perf.slowResponses.slice(0, 5)) {
            lines.push(`    ${ms(r.durationMs)}  [${r.status}] ${r.url}`);
        }
    }

    if (lines.length === 0) return [];

    // Turn the observed settle time into a recommended assertion timeout.
    // Rule of thumb: ~2x observed settle, clamped to a sane [5s, 30s] band,
    // rounded to whole seconds so the generated code reads cleanly.
    if (settleMs !== undefined) {
        const suggested = Math.min(
            30_000,
            Math.max(5_000, Math.ceil((settleMs * 2) / 1000) * 1000),
        );
        lines.push("");
        if (settleMs >= 2_500 || perf.networkIdle === false) {
            lines.push(
                `HINT: This page is slow to settle (~${ms(settleMs)}). Prefer web-first assertions with an explicit timeout (~${suggested}ms), e.g. \`await expect(locator).toBeVisible({ timeout: ${suggested} })\`, and wait on the real signal (waitForURL / waitForResponse / waitForLoadState) after actions that trigger navigation or data loads. Do NOT paper over this with fixed sleeps.`,
            );
        } else {
            lines.push(
                `HINT: This page settles quickly (~${ms(settleMs)}). Default web-first assertions are fine; still wait on concrete signals (waitForURL / waitForResponse) rather than fixed timeouts.`,
            );
        }
    }

    return lines;
}

export function formatDOMContext(dom: DOMContext): string {
    const lines: string[] = [
        "",
        "═══════════════════════════════════════════════════════════════",
        `[LIVE DOM CONTEXT - ${dom.url}]`,
        "═══════════════════════════════════════════════════════════════",
        `Page Title: ${dom.title}`,
        `Captured: ${new Date(dom.timestamp).toISOString()}`,
        "",
    ];

    if (dom._prerequisites && dom._prerequisites.length > 0) {
        lines.push("[PREREQUISITES]");
        lines.push("───────────────");
        lines.push("The following steps may be needed before testing:");
        for (let i = 0; i < dom._prerequisites.length; i++) {
            lines.push(`${i + 1}. ${dom._prerequisites[i]}`);
        }
        lines.push("");
    }

    const behavior = formatPageBehavior(dom.performance);
    if (behavior.length > 0) {
        lines.push("[PAGE BEHAVIOR — observed at capture time]");
        lines.push("──────────────────────────────────────────");
        lines.push(...behavior);
        lines.push("");
    }

    lines.push("ACCESSIBILITY TREE:");
    lines.push("───────────────────");
    lines.push(formatAccessibilityTree(dom.accessibilityTree));
    lines.push("");

    if (dom.interactiveElements && dom.interactiveElements.length > 0) {
        // Cap raised from 30 → 80: complex apps (dashboards, tables, nav-heavy
        // pages) routinely have 40-70 controls, and truncating at 30 hid the
        // very element the agent/test needed, forcing selector guesses.
        const MAX_LISTED = 80;
        lines.push("INTERACTIVE ELEMENTS:");
        lines.push("─────────────────────");
        for (const el of dom.interactiveElements.slice(0, MAX_LISTED)) {
            const typeInfo = el.type ? ` [type=${el.type}]` : "";
            // Surface the link target so the agent can reason about where a
            // control leads (e.g. which link likely hosts a given action)
            // without having to navigate first.
            const hrefInfo = el.href ? ` [href=${el.href}]` : "";
            lines.push(`• ${el.role}: "${el.name}"${typeInfo}${hrefInfo}`);
            lines.push(`  Selectors: ${el.suggestedSelectors.join(" | ")}`);
        }
        if (dom.interactiveElements.length > MAX_LISTED) {
            lines.push(`  ... and ${dom.interactiveElements.length - MAX_LISTED} more`);
        }
        lines.push("");
    }

    // Form fields are already captured (name/type/label/placeholder/required +
    // a grounded suggestedSelector) but were never surfaced to the generator,
    // so tests that fill forms had to guess input selectors. Render them
    // explicitly so login/signup/checkout flows can be filled without guessing.
    if (dom.formFields && dom.formFields.length > 0) {
        const MAX_FIELDS = 40;
        lines.push("FORM FIELDS:");
        lines.push("────────────");
        for (const f of dom.formFields.slice(0, MAX_FIELDS)) {
            const label = f.label || f.placeholder || f.name || "(unlabeled)";
            const req = f.required ? " [required]" : "";
            const typeInfo = f.type ? ` [type=${f.type}]` : "";
            lines.push(`• "${label}"${typeInfo}${req}`);
            lines.push(`  Selector: ${f.suggestedSelector}`);
        }
        if (dom.formFields.length > MAX_FIELDS) {
            lines.push(`  ... and ${dom.formFields.length - MAX_FIELDS} more`);
        }
        lines.push("");
    }

    lines.push("SELECTOR PRIORITY:");
    lines.push("──────────────────");
    lines.push("1. getByRole() - Most reliable, matches accessibility tree");
    lines.push("2. getByLabel() - Great for form inputs");
    lines.push("3. getByText() - For buttons and links");
    lines.push("");
    lines.push("Use ONLY selectors from the tree above. Do NOT fabricate selectors.");
    lines.push("");

    return lines.join("\n");
}
