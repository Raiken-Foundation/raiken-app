/**
 * Live page capture for repair when discovery snapshots miss the failing URL
 * or timeout locators cannot be verified against known captures.
 */

import { validateSelectorGrounding } from "../agent/grounding";
import { formatDOMContext } from "../browser/dom-capture";
import { BrowserSession } from "../browser/session";
import { resolveAuthStorageStatePath } from "../config/auth-state";
import type { RepairEvidence } from "./evidence";
import { describeTimeoutFocus } from "./repair-setup";

export interface RepairCaptureDecision {
    /** Absolute URL to open, when one can be resolved. */
    url: string | null;
    /** Why a live capture is warranted (empty → skip). */
    reasons: string[];
}

export interface LiveRepairCaptureResult {
    /** Formatted DOM summary suitable for repair prompts / grounding. */
    summary: string | null;
    url: string | null;
    /** Human-readable status for stderr / JSON. */
    message: string;
}

/** First `page.goto('...')` target in source order. */
export function extractFirstGotoTarget(testCode: string): string | null {
    const match = /page\.goto\s*\(\s*(['"`])([^'"`\n]+)\1/.exec(testCode);
    const target = match?.[2]?.trim();
    return target && target.length > 0 ? target : null;
}

/** Resolve a goto target against baseURL into an absolute http(s) URL. */
export function resolveFailureUrl(
    gotoTarget: string | null,
    baseURL: string | null,
): string | null {
    if (!gotoTarget) return null;
    if (/^https?:\/\//i.test(gotoTarget)) return gotoTarget;
    if (!baseURL) return null;
    try {
        return new URL(gotoTarget, baseURL).toString();
    } catch {
        return null;
    }
}

function normalizeUrlKey(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/\/+$/, "") || "/";
        return `${parsed.origin}${path}`.toLowerCase();
    } catch {
        return url.replace(/\/+$/, "").toLowerCase();
    }
}

/** True when any discovery snapshot header mentions this URL (loose match). */
export function discoveryCoversUrl(url: string, snapshots: string[]): boolean {
    const key = normalizeUrlKey(url);
    const pathOnly = (() => {
        try {
            return new URL(url).pathname.replace(/\/+$/, "") || "/";
        } catch {
            return null;
        }
    })();

    for (const snap of snapshots) {
        const header = snap.slice(0, 400);
        if (header.toLowerCase().includes(key)) return true;
        if (pathOnly && pathOnly !== "/" && header.includes(pathOnly)) return true;
        // Snapshot format from gatherRepairEvidence: `Page: <url>\n...`
        const pageLine = /^Page:\s*(\S+)/m.exec(snap);
        if (pageLine?.[1] && normalizeUrlKey(pageLine[1]) === key) return true;
    }
    return false;
}

/**
 * Decide whether repair should open a browser because discovery knowledge
 * does not cover the failing entry URL / timeout locators.
 */
export function shouldLiveCaptureRepairPage(
    testCode: string,
    failureText: string,
    evidence: Pick<RepairEvidence, "snapshots" | "baseURL" | "sourceSelectors">,
): RepairCaptureDecision {
    const reasons: string[] = [];
    const gotoTarget = extractFirstGotoTarget(testCode);
    const url = resolveFailureUrl(gotoTarget, evidence.baseURL);

    if (url && !discoveryCoversUrl(url, evidence.snapshots)) {
        reasons.push(`entry URL ${url} has no matching discovery snapshot`);
    }

    const timeoutFocus = describeTimeoutFocus(failureText);
    if (timeoutFocus && evidence.snapshots.length > 0) {
        const grounding = validateSelectorGrounding(
            testCode,
            evidence.snapshots,
            evidence.sourceSelectors,
        );
        if (grounding.unverified.length > 0 || grounding.contradictions.length > 0) {
            reasons.push("timeout locators are unverified or contradicted by discovery snapshots");
        }
    } else if (timeoutFocus && evidence.snapshots.length === 0 && url) {
        reasons.push("timeout failure with no discovery snapshots");
    }

    // No URL to open → cannot live-capture even if locators miss.
    if (!url) {
        return { url: null, reasons: [] };
    }

    return { url, reasons };
}

/**
 * Navigate to `url` once, capture an ARIA/DOM summary, then close the session.
 * Returns summary null when navigation fails (caller keeps discovery-only evidence).
 */
export async function captureRepairPage(
    projectPath: string,
    options: { url: string; headed?: boolean },
): Promise<LiveRepairCaptureResult> {
    const storageStatePath = resolveAuthStorageStatePath(projectPath) ?? undefined;
    const session = BrowserSession.getInstance(projectPath);

    try {
        await session.start({
            headless: options.headed !== true,
            ...(storageStatePath ? { storageStatePath } : {}),
        });
        const dom = await session.navigate(options.url);
        const summary = formatDOMContext(dom);
        return {
            summary,
            url: options.url,
            message: `Re-captured ${options.url} (not in discovery)`,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            summary: null,
            url: options.url,
            message: `Could not re-capture ${options.url}: ${detail} — using discovery evidence only`,
        };
    } finally {
        await session.close().catch(() => undefined);
    }
}

/**
 * When knowledge misses, live-capture and prepend the summary for repair.
 */
export async function maybeCaptureMissingRepairPage(input: {
    projectPath: string;
    testCode: string;
    failureText: string;
    evidence: RepairEvidence;
    headed?: boolean;
}): Promise<{
    liveSummary: string | null;
    pageSummaries: string[];
    message: string | null;
}> {
    const decision = shouldLiveCaptureRepairPage(input.testCode, input.failureText, input.evidence);
    if (decision.reasons.length === 0 || !decision.url) {
        return {
            liveSummary: null,
            pageSummaries: input.evidence.snapshots,
            message: null,
        };
    }

    const captured = await captureRepairPage(input.projectPath, {
        url: decision.url,
        headed: input.headed,
    });

    if (!captured.summary) {
        return {
            liveSummary: null,
            pageSummaries: input.evidence.snapshots,
            message: captured.message,
        };
    }

    return {
        liveSummary: captured.summary,
        pageSummaries: [captured.summary, ...input.evidence.snapshots],
        message: captured.message,
    };
}
