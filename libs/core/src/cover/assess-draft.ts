/**
 * Shared post-generation contract for cover and oneshot: structure, polarity,
 * Playwright fit, selector grounding, and auth grounding.
 */

import type { GroundingReport } from "../agent/grounding";
import { validateSelectorGrounding } from "../agent/grounding";
import {
    assessAssertionPolarity,
    assessDraftStructure,
    assessPlaywrightFit,
} from "./draft-quality";
import { type CoverEvidence, hasAuthGrounding, looksLikeAuthScenario } from "./evidence";
import { assessIntentCoverage } from "./intent-coverage";
import { scenarioExpectedTokens } from "./repair-setup";

export interface AssessGeneratedDraftInput {
    body: string;
    projectPath: string;
    outputPath: string;
    evidence: CoverEvidence;
    description: string;
    /** Extra soft review reasons already known (e.g. steered output path). */
    extraReviewReasons?: string[];
}

export interface AssessGeneratedDraftResult {
    grounding: GroundingReport;
    blocked: boolean;
    needsReview: boolean;
    reviewReasons: string[];
    todoNotes: number;
    /** TODOs whose code is commented out — the draft cannot run without them. */
    blockingTodos: number;
    /**
     * True when a review reason is grounding-driven: the draft asserts
     * locators or post-auth state that no captured page / source markup /
     * saved session proves. Such drafts are stamped `@raiken-unverified` so
     * `raiken test` refuses to run them as if they were verified.
     */
    groundingDriven: boolean;
}

/**
 * The marker cover stamps on drafts whose review is grounding-driven. `raiken
 * test` refuses (exit 1) specs carrying it unless `--allow-unverified` is
 * passed — an unverified draft must not green-light CI.
 */
export const UNVERIFIED_MARKER = "@raiken-unverified";

/** True when a spec carries the unverified marker. */
export function containsUnverifiedMarker(code: string): boolean {
    return code.includes(UNVERIFIED_MARKER);
}

/**
 * Split TODO markers into blockers vs notes.
 *
 * A TODO inside a string literal is a placeholder VALUE the test would
 * execute (`'TODO: Define product page URL'`). A TODO in a comment is the
 * model flagging an optional follow-up on a draft that runs as written.
 */
export interface TodoMarkerAssessment {
    placeholders: number;
    blocking: number;
    notes: number;
}

export function assessTodoMarkers(body: string): TodoMarkerAssessment {
    const placeholders = (body.match(/(['"`])[^'"`\n]*\bTODO\b[^'"`\n]*\1/g) ?? []).length;
    const total = (body.match(/\bTODO\b/g) ?? []).length;
    const blocking = countBlockingTodos(body);
    return { placeholders, blocking, notes: Math.max(0, total - placeholders - blocking) };
}

/**
 * A `// TODO:` that stands in for a required step the model could not ground:
 * its code is COMMENTED OUT on the line(s) immediately below. Distinct from an
 * optional note (a TODO whose next line is real, executable code) and from a
 * string-literal placeholder.
 */
function countBlockingTodos(body: string): number {
    const lines = body.split("\n");
    let blocking = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!/^\s*\/\/\s*TODO\b/i.test(line)) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j] ?? "";
            if (!next.trim()) continue;
            if (
                /^\s*\/\/\s*(await\b|page\.|const\s+\w+\s*=|let\s+\w+\s*=|expect\(|\.(fill|click|goto|selectOption|check|uncheck|press|hover|type|dblclick)\(|test\(|describe\()/.test(
                    next,
                )
            ) {
                blocking += 1;
            }
            break;
        }
    }
    return blocking;
}

/**
 * Name the missing half of an auth scenario: no saved session means discovery
 * only ever saw the signed-out app, so anything the draft asserts after the
 * sign-in click is invention. Includes the two commands that close the gap.
 */
export function describeSignedOutKnowledgeGap(evidence: CoverEvidence): string {
    const loginUrl =
        evidence.authLogin?.url ??
        evidence.pages.find((page) => /login|signin|sign-in|auth/i.test(page.url))?.url ??
        null;
    const authCommand = loginUrl ? `raiken auth --url ${loginUrl}` : "raiken auth";
    const discoverCommand = evidence.baseURL
        ? `raiken discover ${evidence.baseURL}`
        : "raiken discover <url>";
    const preamble = evidence.hasStorageState
        ? "a session is saved, but no captured page was crawled with it, so discovery only " +
          "ever saw the signed-out app"
        : "no saved browser session, so discovery only crawled the signed-out app";
    // With a session already on disk the auth step is done; re-running discover
    // is the whole fix, so leading with `raiken auth` would send people back
    // through a login they have already completed.
    const remedy = evidence.hasStorageState
        ? `Run \`${discoverCommand}\` to crawl with that session.`
        : `Run \`${authCommand}\`, then \`${discoverCommand}\` to capture the pages behind the login.`;
    return `${preamble} — everything this draft expects AFTER sign-in is unverified. ${remedy}`;
}

/**
 * Hold a generated Playwright draft to the same honesty gates cover uses.
 */
export async function assessGeneratedDraft(
    input: AssessGeneratedDraftInput,
): Promise<AssessGeneratedDraftResult> {
    const { body, projectPath, outputPath, evidence, description } = input;
    const reviewReasons: string[] = [...(input.extraReviewReasons ?? [])];
    const hardBlockReasons: string[] = [];
    let groundingDriven = false;

    const grounding = validateSelectorGrounding(
        body,
        evidence.snapshots,
        evidence.sourceSelectors,
        scenarioExpectedTokens(description),
    );

    const structure = assessDraftStructure(body);
    if (!structure.ok) {
        hardBlockReasons.push(`draft is not valid Playwright/TS: ${structure.reason}`);
    }

    const polarity = assessAssertionPolarity(body);
    if (polarity.allNegative && polarity.reason) {
        reviewReasons.push(polarity.reason);
    }

    const intent = assessIntentCoverage(description, body);
    for (const reason of intent.reasons) {
        reviewReasons.push(reason);
    }
    // A scenario draft that carries no assertions at all passes vacuously on a
    // broken app — the "test matches the code" anti-pattern — so it cannot be
    // verified by any run. Treat vacuity as grounding-driven: stamp the marker
    // so `raiken test` refuses it until a human makes the draft actually assert
    // the scenario. (Partial token-miss with assertions present stays soft.)
    if (intent.vacuous) {
        groundingDriven = true;
    }

    const {
        placeholders: todoPlaceholders,
        blocking: todoBlocking,
        notes: todoNotes,
    } = assessTodoMarkers(body);
    if (todoPlaceholders > 0) {
        reviewReasons.push(`${todoPlaceholders} TODO placeholder value(s) must be replaced`);
    }
    if (todoBlocking > 0) {
        groundingDriven = true;
        reviewReasons.push(
            `${todoBlocking} step(s) are stubbed as TODO comments with their code commented out — ` +
                "the draft cannot run until they are filled in",
        );
    }

    if (grounding.contradictions.length > 0) {
        groundingDriven = true;
        reviewReasons.push(
            `${grounding.contradictions.length} locator(s) contradict captured pages`,
        );
    }
    if (grounding.unverified.length > 0) {
        groundingDriven = true;
        reviewReasons.push(
            `${grounding.unverified.length} locator(s) match neither captured pages nor source markup`,
        );
    }
    if (grounding.warnings.length > 0) {
        groundingDriven = true;
        const valueCount = grounding.warnings.filter((w) => w.kind === "unknown_value").length;
        const locatorCount = grounding.warnings.length - valueCount;
        const parts: string[] = [];
        if (locatorCount > 0) {
            parts.push(`${locatorCount} locator(s) assert text/CSS not seen in captured pages`);
        }
        if (valueCount > 0) {
            parts.push(`${valueCount} value(s) asserted but not seen in captured pages`);
        }
        reviewReasons.push(parts.join("; "));
    }

    const fit = await assessPlaywrightFit(projectPath, outputPath);
    if (!fit.collectedByConfig && fit.reason) {
        hardBlockReasons.push(fit.reason);
    }

    if (looksLikeAuthScenario(description)) {
        if (!hasAuthGrounding(evidence)) {
            groundingDriven = true;
            reviewReasons.push(
                "auth scenario has no login-page snapshot, observed login form, or storageState — " +
                    "run `raiken discover` (captures /login even with --skip-auth) and/or `raiken auth` " +
                    "before treating this draft as grounded",
            );
        } else if (!evidence.hasAuthenticatedKnowledge) {
            // The login page itself is grounded, but nothing was ever captured
            // from behind it, so every page AFTER sign-in is a guess. Keyed on
            // captured pages rather than on a saved session, because saving a
            // session adds no knowledge on its own — checking the file here is
            // what used to silence this warning while the invention continued.
            groundingDriven = true;
            reviewReasons.push(describeSignedOutKnowledgeGap(evidence));
        }
    }

    const allReasons = [...hardBlockReasons, ...reviewReasons];
    return {
        grounding,
        blocked: hardBlockReasons.length > 0,
        needsReview: allReasons.length > 0,
        reviewReasons: allReasons,
        todoNotes,
        blockingTodos: todoBlocking,
        groundingDriven,
    };
}
