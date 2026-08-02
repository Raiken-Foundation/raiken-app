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
import {
    type CoverEvidence,
    hasAuthGrounding,
    looksLikeAuthScenario,
} from "./evidence";
import { assessIntentCoverage } from "./intent-coverage";

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
}

/**
 * Split TODO markers into blockers vs notes.
 *
 * A TODO inside a string literal is a placeholder VALUE the test would
 * execute (`'TODO: Define product page URL'`). A TODO in a comment is the
 * model flagging an optional follow-up on a draft that runs as written.
 */
export function assessTodoMarkers(body: string): { placeholders: number; notes: number } {
    const placeholders = (body.match(/(['"`])[^'"`\n]*\bTODO\b[^'"`\n]*\1/g) ?? []).length;
    const total = (body.match(/\bTODO\b/g) ?? []).length;
    return { placeholders, notes: Math.max(0, total - placeholders) };
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
    return (
        "no saved browser session, so discovery only crawled the signed-out app — " +
        "everything this draft expects AFTER sign-in is unverified. " +
        `Run \`${authCommand}\`, then \`${discoverCommand}\` to capture the pages behind the login.`
    );
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

    const grounding = validateSelectorGrounding(
        body,
        evidence.snapshots,
        evidence.sourceSelectors,
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

    const { placeholders: todoPlaceholders, notes: todoNotes } = assessTodoMarkers(body);
    if (todoPlaceholders > 0) {
        reviewReasons.push(`${todoPlaceholders} TODO placeholder value(s) must be replaced`);
    }

    if (grounding.contradictions.length > 0) {
        reviewReasons.push(
            `${grounding.contradictions.length} locator(s) contradict captured pages`,
        );
    }
    if (grounding.unverified.length > 0) {
        reviewReasons.push(
            `${grounding.unverified.length} locator(s) match neither captured pages nor source markup`,
        );
    }
    if (grounding.warnings.length > 0) {
        reviewReasons.push(
            `${grounding.warnings.length} locator(s) assert text/CSS not seen in captured pages`,
        );
    }

    const fit = await assessPlaywrightFit(projectPath, outputPath);
    if (!fit.collectedByConfig && fit.reason) {
        hardBlockReasons.push(fit.reason);
    }

    if (looksLikeAuthScenario(description)) {
        if (!hasAuthGrounding(evidence)) {
            reviewReasons.push(
                "auth scenario has no login-page snapshot, observed login form, or storageState — " +
                    "run `raiken discover` (captures /login even with --skip-auth) and/or `raiken auth` " +
                    "before treating this draft as grounded",
            );
        } else if (!evidence.hasStorageState) {
            // The login page itself is grounded, but discovery ran signed-out,
            // so every page AFTER sign-in is a guess. That is the silent way an
            // auth draft turns into invented headings and routes.
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
    };
}
