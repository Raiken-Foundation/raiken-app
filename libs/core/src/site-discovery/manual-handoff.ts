/**
 * Manual browser handoff
 *
 * Dashboard-side wrapper around {@link runInteractiveAuthHandoff}. Keeps the
 * public `runManualHandoff` contract stable while the headed-Chromium loop
 * lives in `libs/core/src/browser/interactive-auth-handoff.ts`.
 */

import {
    DEFAULT_HANDOFF_TIMEOUT_MS,
    type InteractiveAuthHandoffProgress,
    type InteractiveAuthHandoffReason,
    runInteractiveAuthHandoff,
} from "../browser/interactive-auth-handoff";
import type { DiscoveryBlocker } from "./types";

/** How a dashboard handoff loop terminated. */
export type ManualHandoffReason = InteractiveAuthHandoffReason;

export interface ManualHandoffOptions {
    /** Project root — controls where `auth-state.json` is written. */
    projectPath: string;
    /** Where to navigate the new window. Required: handoff at an unknown URL is meaningless. */
    url: string;
    /** Override the destination path; defaults to `<projectPath>/.raiken/auth-state.json`. */
    storageStatePath?: string;
    /** Override the auto-save timeout (ms). Defaults to 5 minutes. */
    timeoutMs?: number;
    /** External cancellation (e.g. dashboard abort/clear). */
    signal?: AbortSignal;
    /**
     * If provided, this blocker (and any other unresolved auth-category
     * blocker for the project) gets marked resolved with
     * `{ resolution: "handoff" }` once the snapshot is saved.
     */
    blockerId?: number | null;
    /**
     * Optional category to record on the resolution. Defaults to whatever
     * the targeted blocker carries, or `"auth_required"` if no id given —
     * keeps `auth_state.json` semantically a *credentials* artifact even
     * when triggered by a captcha pause.
     */
    category?: DiscoveryBlocker["category"];
    /** Chromium launch flag. Almost always `false` for a real handoff. */
    headless?: boolean;
    /** Optional poll tuning — forwarded to the shared handoff loop. */
    pollIntervalMs?: number;
    stabilityPolls?: number;
    /**
     * Per-poll callback so the caller can stream "still waiting…" updates
     * into the discovery timeline. Receives the current cookie/origin
     * counts and the page URL so the dashboard can show progress.
     */
    onProgress?: (snapshot: ManualHandoffProgress) => void;
}

export interface ManualHandoffProgress {
    cookies: number;
    origins: number;
    url: string;
    reason?: ManualHandoffReason;
    /** Present when auth state saved but blocker resolution failed. */
    blockerResolutionWarning?: string;
    /** Human-readable detail when `reason` is `"error"`. */
    errorMessage?: string;
}

export interface ManualHandoffResult {
    /** Where the snapshot was written. */
    storageStatePath: string;
    cookies: number;
    origins: number;
    /** How the loop terminated. */
    reason: ManualHandoffReason;
    /** Number of blockers we marked resolved with `resolution: "handoff"`. */
    blockersResolved: number;
    /**
     * Whether the snapshot was written. False when the loop ended without a
     * confirmed login (browser closed, timeout, abort), in which case any
     * existing `auth-state.json` is left untouched.
     */
    persisted: boolean;
    /** Set when auth state was saved but blocker resolution failed. */
    blockerResolutionWarning?: string;
    /** Human-readable detail when `reason` is `"error"`. */
    errorMessage?: string;
}

function mapProgress(snapshot: InteractiveAuthHandoffProgress): ManualHandoffProgress {
    return {
        cookies: snapshot.cookies,
        origins: snapshot.origins,
        url: snapshot.url,
        reason: snapshot.reason,
        blockerResolutionWarning: snapshot.blockerResolutionWarning,
        errorMessage: snapshot.errorMessage,
    };
}

/**
 * Open a headful browser at `options.url`, watch for the user to clear
 * whatever blocker is in the way, snapshot the cookies + localStorage to
 * `auth-state.json`, mark blockers resolved, return.
 */
export async function runManualHandoff(
    options: ManualHandoffOptions,
): Promise<ManualHandoffResult> {
    const result = await runInteractiveAuthHandoff({
        projectPath: options.projectPath,
        url: options.url,
        storageStatePath: options.storageStatePath,
        timeoutMs: options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
        signal: options.signal,
        headless: options.headless,
        pollIntervalMs: options.pollIntervalMs,
        stabilityPolls: options.stabilityPolls,
        category: options.category ?? "auth_required",
        onProgress: options.onProgress
            ? (snapshot) => options.onProgress?.(mapProgress(snapshot))
            : undefined,
        blockerResolution: {
            kind: "dashboard_handoff",
            blockerId: options.blockerId ?? null,
            category: options.category ?? "auth_required",
            resolvedVia: "dashboard_handoff",
        },
    });

    return {
        storageStatePath: result.storageStatePath,
        cookies: result.cookies,
        origins: result.origins,
        reason: result.reason,
        blockersResolved: result.blockersResolved,
        persisted: result.persisted,
        blockerResolutionWarning: result.blockerResolutionWarning,
        errorMessage: result.errorMessage,
    };
}
