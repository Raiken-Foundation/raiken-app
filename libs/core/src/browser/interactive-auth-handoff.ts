/**
 * Interactive auth / blocker handoff
 *
 * Shared headed-Chromium loop used by `raiken auth` and dashboard discovery
 * handoffs. Callers supply UX adapters (stdio Enter, progress callbacks,
 * timeout/abort) while this module owns baseline capture, change detection,
 * stability polling, validated state writes, and category-scoped blocker
 * resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { resolveAuthStorageStateDestination, writeValidatedAuthState } from "../config/auth-state";
import { resolvePathWithinProject } from "../config/store";
import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "../site-discovery/db";
import { looksLikeLoginUrl } from "../site-discovery/detectors/auth";
import type { BlockerResolution, DiscoveryBlocker } from "../site-discovery/types";
import { loadPlaywrightChromium } from "./playwright-loader";

export const HANDOFF_POLL_INTERVAL_MS = 1500;
/** Consecutive identical polls after a change before saving. */
export const HANDOFF_STABILITY_POLLS = 2;
export const DEFAULT_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;

export type InteractiveAuthHandoffReason =
    | "auto"
    | "manual"
    | "browser-closed"
    | "timeout"
    | "abort"
    | "error";

export class HandoffBlockerResolutionError extends Error {
    readonly code = "HANDOFF_BLOCKER_RESOLUTION_FAILED" as const;
    readonly storageStatePath: string;
    readonly blockersResolved: number;

    constructor(args: {
        storageStatePath: string;
        blockersResolved: number;
        cause: unknown;
    }) {
        const detail = describeHandoffFailureCause(args.cause);
        super(
            `Auth state saved at ${args.storageStatePath}, but blocker resolution failed: ${detail}`,
        );
        this.name = "HandoffBlockerResolutionError";
        this.storageStatePath = args.storageStatePath;
        this.blockersResolved = args.blockersResolved;
        this.cause = args.cause;
    }
}

function describeHandoffFailureCause(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

export interface StorageBaseline {
    cookieKeys: Set<string>;
    originKeys: Set<string>;
    initialUrl: string;
}

export type PlaywrightStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface InteractiveAuthHandoffProgress {
    cookies: number;
    origins: number;
    url: string;
    phase: "waiting" | "confirming" | "done";
    stableHits?: number;
    stabilityPolls?: number;
    reason?: InteractiveAuthHandoffReason;
    blockerResolutionWarning?: string;
    errorMessage?: string;
}

export interface ManualCompletionWatcher {
    promise: Promise<void>;
    cancel: () => void;
}

export type HandoffBlockerResolutionStrategy =
    | { kind: "auth_command" }
    | {
          kind: "dashboard_handoff";
          blockerId?: number | null;
          category?: DiscoveryBlocker["category"];
          resolvedVia?: string;
      };

export interface InteractiveAuthHandoffOptions {
    projectPath: string;
    url: string;
    storageStatePath?: string;
    headless?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Blocker category driving detection strictness. `auth_required` applies
     * the login-page stability gate so incidental cookies on a login form do
     * not count as authenticated.
     */
    category?: DiscoveryBlocker["category"];
    onProgress?: (snapshot: InteractiveAuthHandoffProgress) => void;
    createManualCompletionWatcher?: () => ManualCompletionWatcher;
    /** Called after navigation attempt, before baseline capture. */
    onBrowserReady?: () => void;
    blockerResolution?: HandoffBlockerResolutionStrategy;
    pollIntervalMs?: number;
    stabilityPolls?: number;
}

export interface InteractiveAuthHandoffResult {
    storageStatePath: string;
    cookies: number;
    origins: number;
    reason: InteractiveAuthHandoffReason;
    blockersResolved: number;
    storageState: PlaywrightStorageState | null;
    /** Whether the session state was actually written to `storageStatePath`. */
    persisted: boolean;
    /** Set when auth state was saved but blocker resolution failed. */
    blockerResolutionWarning?: string;
    /** Human-readable detail when `reason` is `"error"`. */
    errorMessage?: string;
}

export function cookieStorageKey(c: { name: string; domain: string; path: string }): string {
    return `${c.domain}\u0000${c.path}\u0000${c.name}`;
}

export function originStorageEntries(o: {
    origin: string;
    localStorage?: Array<{ name: string }>;
}): string[] {
    return (o.localStorage ?? []).map((item) => `${o.origin}\u0000${item.name}`);
}

export function isLoginOrPreNavigation(url: string): boolean {
    if (!url || url === "about:blank") return true;
    return looksLikeLoginUrl(url);
}

export function safePageUrl(page: Page): string {
    try {
        return page.url();
    } catch {
        return "";
    }
}

export function snapshotStorageKey(state: PlaywrightStorageState, currentUrl: string): string {
    const cookies = state.cookies.map(cookieStorageKey).sort().join("|");
    const origins = state.origins.flatMap(originStorageEntries).sort().join("|");
    return `${currentUrl}::${cookies}::${origins}`;
}

export async function captureStorageBaseline(
    context: BrowserContext,
    page: Page,
): Promise<StorageBaseline> {
    let state: PlaywrightStorageState;
    try {
        state = await context.storageState();
    } catch {
        return {
            cookieKeys: new Set(),
            originKeys: new Set(),
            initialUrl: safePageUrl(page),
        };
    }

    return {
        cookieKeys: new Set(state.cookies.map(cookieStorageKey)),
        originKeys: new Set(state.origins.flatMap(originStorageEntries)),
        initialUrl: safePageUrl(page),
    };
}

/** Any material cookie, storage, or redirect-away-from-login change. */
export function detectMaterialChange(
    baseline: StorageBaseline,
    state: PlaywrightStorageState,
    currentUrl: string,
): boolean {
    const newCookie = state.cookies.some((c) => !baseline.cookieKeys.has(cookieStorageKey(c)));
    const newOrigin = state.origins
        .flatMap(originStorageEntries)
        .some((entry) => !baseline.originKeys.has(entry));
    if (newCookie || newOrigin) return true;

    const initialIsLogin = isLoginOrPreNavigation(baseline.initialUrl);
    if (initialIsLogin && currentUrl && !isLoginOrPreNavigation(currentUrl)) {
        return true;
    }

    return false;
}

/**
 * Auth-specific completion: cred-bearing artifacts only count when the user
 * has left the login page (or the session started off-login). Redirect off a
 * login URL alone is sufficient.
 */
export function detectAuthLoginCompletion(
    baseline: StorageBaseline,
    state: PlaywrightStorageState,
    currentUrl: string,
): boolean {
    const newCookie = state.cookies.some((c) => !baseline.cookieKeys.has(cookieStorageKey(c)));
    const newOrigin = state.origins
        .flatMap(originStorageEntries)
        .some((entry) => !baseline.originKeys.has(entry));

    const initialIsLogin = isLoginOrPreNavigation(baseline.initialUrl);

    if ((newCookie || newOrigin) && (!initialIsLogin || !isLoginOrPreNavigation(currentUrl))) {
        return true;
    }

    if (initialIsLogin && currentUrl && !isLoginOrPreNavigation(currentUrl)) {
        return true;
    }

    return false;
}

export function detectHandoffCompletion(
    baseline: StorageBaseline,
    state: PlaywrightStorageState,
    currentUrl: string,
    category: DiscoveryBlocker["category"] | undefined,
): boolean {
    const effectiveCategory = category ?? "auth_required";
    if (effectiveCategory === "auth_required") {
        return detectAuthLoginCompletion(baseline, state, currentUrl);
    }
    return detectMaterialChange(baseline, state, currentUrl);
}

export function resolveHandoffStorageStatePath(
    projectPath: string,
    storageStatePath: string | undefined,
): string {
    return storageStatePath !== undefined
        ? resolvePathWithinProject(projectPath, storageStatePath)
        : resolveAuthStorageStateDestination(projectPath);
}

export function resolveHandoffBlockers(
    projectPath: string,
    args: {
        storageStatePath: string;
        strategy: HandoffBlockerResolutionStrategy;
    },
): number {
    const db = new CodeGraphDB(projectPath);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);

        if (args.strategy.kind === "auth_command") {
            const blockers = siteDb.getUnresolvedBlockers();
            let touched = 0;
            for (const blocker of blockers) {
                if (blocker.id && blocker.category === "auth_required") {
                    siteDb.markBlockerResolved(blocker.id, args.storageStatePath);
                    touched += 1;
                }
            }
            return touched;
        }

        const {
            blockerId = null,
            category = "auth_required",
            resolvedVia = "dashboard_handoff",
        } = args.strategy;
        const resolution: BlockerResolution = "handoff";

        if (blockerId) {
            siteDb.markBlockerResolved(blockerId, {
                resolution,
                resolvedVia,
                storageStatePath: args.storageStatePath,
            });
        }

        const all = siteDb.getUnresolvedBlockers();
        let resolved = blockerId ? 1 : 0;
        for (const blocker of all) {
            if (blocker.id === blockerId) continue;
            if (blocker.category === "auth_required" || blocker.category === category) {
                if (blocker.id) {
                    siteDb.markBlockerResolved(blocker.id, {
                        resolution,
                        resolvedVia,
                        storageStatePath: args.storageStatePath,
                    });
                    resolved += 1;
                }
            }
        }
        return resolved;
    } catch (cause) {
        throw new HandoffBlockerResolutionError({
            storageStatePath: args.storageStatePath,
            blockersResolved: 0,
            cause,
        });
    } finally {
        db.close();
    }
}

function handoffDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch Chromium, watch for interactive completion, snapshot validated
 * storage state, and optionally resolve blockers.
 */
/**
 * Only a completed login is evidence worth persisting.
 *
 * A closed browser, a timeout, or an abort all mean the handoff ended before
 * login was confirmed. Writing the context anyway would save a half-finished
 * session over a previously working one — and resolving blockers on top of it
 * would resume discovery against an unauthenticated site.
 */
export function shouldPersistHandoffState(reason: InteractiveAuthHandoffReason): boolean {
    return reason === "auto" || reason === "manual";
}

function shouldResolveHandoffBlockers(reason: InteractiveAuthHandoffReason): boolean {
    return shouldPersistHandoffState(reason);
}

export async function runInteractiveAuthHandoff(
    options: InteractiveAuthHandoffOptions,
): Promise<InteractiveAuthHandoffResult> {
    const projectPath = options.projectPath;
    const storageStatePath = resolveHandoffStorageStatePath(projectPath, options.storageStatePath);
    const storageStateDir = path.dirname(storageStatePath);
    const headless = options.headless ?? false;
    const pollIntervalMs = options.pollIntervalMs ?? HANDOFF_POLL_INTERVAL_MS;
    const stabilityPolls = options.stabilityPolls ?? HANDOFF_STABILITY_POLLS;
    const category = options.category ?? "auth_required";

    if (!fs.existsSync(storageStateDir)) {
        fs.mkdirSync(storageStateDir, { recursive: true });
    }

    const chromium = loadPlaywrightChromium();
    const browser: Browser = await chromium.launch({
        headless,
        args: headless ? [] : ["--start-maximized"],
    });
    // Everything between launch and the race setup can throw (newContext,
    // newPage, the caller-supplied onBrowserReady hook). Without this guard
    // the rejection escapes with no browser.close() — a zombie Chromium
    // process per failed handoff (review finding).
    let context: BrowserContext;
    let page: Page;
    try {
        context = await browser.newContext({ viewport: null });
        page = await context.newPage();

        const url = options.url ?? "about:blank";
        if (url !== "about:blank") {
            try {
                await page.goto(url, { waitUntil: "domcontentloaded" });
            } catch {
                // Partial loads and manual navigation still allow handoff success.
            }
        }

        options.onBrowserReady?.();
    } catch (error) {
        try {
            await browser.close();
        } catch {
            /* the original error is the useful one */
        }
        throw error;
    }

    const baseline = await captureStorageBaseline(context, page);

    let reason: InteractiveAuthHandoffReason = "auto";
    let aborted = false;

    const browserClosed = new Promise<void>((resolve) => {
        browser.once("disconnected", () => {
            reason = "browser-closed";
            resolve();
        });
    });

    const timeoutPromise =
        options.timeoutMs === undefined
            ? null
            : new Promise<void>((resolve) => {
                  setTimeout(() => {
                      reason = "timeout";
                      resolve();
                  }, options.timeoutMs).unref?.();
              });

    const abortPromise =
        options.signal === undefined
            ? null
            : new Promise<void>((resolve) => {
                  if (options.signal?.aborted) {
                      reason = "abort";
                      resolve();
                      return;
                  }
                  options.signal?.addEventListener(
                      "abort",
                      () => {
                          reason = "abort";
                          resolve();
                      },
                      { once: true },
                  );
              });

    const manualWatcher = options.createManualCompletionWatcher?.();
    const manualPromise = manualWatcher?.promise.then(() => {
        reason = "manual";
    });

    const detectPromise = (async () => {
        let stableHits = 0;
        let lastSnapshot: string | null = null;

        while (!aborted) {
            await handoffDelay(pollIntervalMs);
            if (aborted) return;

            let storageState: PlaywrightStorageState;
            try {
                storageState = await context.storageState();
            } catch {
                return;
            }

            const currentUrl = safePageUrl(page);
            const detected = detectHandoffCompletion(baseline, storageState, currentUrl, category);
            const snapshot = snapshotStorageKey(storageState, currentUrl);

            if (detected) {
                if (lastSnapshot === snapshot) {
                    stableHits += 1;
                } else {
                    stableHits = 1;
                }
                lastSnapshot = snapshot;
                options.onProgress?.({
                    cookies: storageState.cookies.length,
                    origins: storageState.origins.length,
                    url: currentUrl,
                    phase: "confirming",
                    stableHits,
                    stabilityPolls,
                });
                if (stableHits >= stabilityPolls) {
                    reason = "auto";
                    return;
                }
            } else {
                stableHits = 0;
                lastSnapshot = snapshot;
                options.onProgress?.({
                    cookies: storageState.cookies.length,
                    origins: storageState.origins.length,
                    url: currentUrl,
                    phase: "waiting",
                });
            }
        }
    })();

    const racers: Array<Promise<void>> = [detectPromise, browserClosed];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    if (manualPromise) racers.push(manualPromise);

    await Promise.race(racers);
    aborted = true;
    manualWatcher?.cancel();
    const completion: { reason: InteractiveAuthHandoffReason } = { reason };

    let storageState: PlaywrightStorageState | null = null;
    try {
        storageState = await context.storageState();
    } catch {
        storageState = null;
    }

    try {
        await browser.close();
    } catch {
        // already closed
    }

    if (!storageState) {
        options.onProgress?.({
            cookies: 0,
            origins: 0,
            url: "",
            phase: "done",
            reason: completion.reason === "auto" ? "error" : completion.reason,
            errorMessage:
                completion.reason === "auto"
                    ? "Could not read browser session state before login was detected."
                    : "Could not read browser session state.",
        });
        return {
            storageStatePath,
            cookies: 0,
            origins: 0,
            reason: completion.reason === "auto" ? "error" : completion.reason,
            blockersResolved: 0,
            storageState: null,
            persisted: false,
            errorMessage:
                completion.reason === "auto"
                    ? "Could not read browser session state before login was detected."
                    : "Could not read browser session state.",
        };
    }

    const persisted = shouldPersistHandoffState(completion.reason);
    if (persisted) {
        try {
            writeValidatedAuthState(storageStatePath, storageState);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            options.onProgress?.({
                cookies: storageState.cookies.length,
                origins: storageState.origins.length,
                url: safePageUrl(page),
                phase: "done",
                reason: "error",
                errorMessage: message,
            });
            return {
                storageStatePath,
                cookies: storageState.cookies.length,
                origins: storageState.origins.length,
                reason: "error",
                blockersResolved: 0,
                storageState,
                persisted: false,
                errorMessage: message,
            };
        }
    }

    let blockersResolved = 0;
    let blockerResolutionWarning: string | undefined;
    if (persisted && options.blockerResolution && shouldResolveHandoffBlockers(completion.reason)) {
        try {
            blockersResolved = resolveHandoffBlockers(projectPath, {
                storageStatePath,
                strategy: options.blockerResolution,
            });
        } catch (error) {
            blockerResolutionWarning =
                error instanceof HandoffBlockerResolutionError
                    ? error.message
                    : `Auth state saved at ${storageStatePath}, but blocker resolution failed.`;
        }
    }

    options.onProgress?.({
        cookies: storageState.cookies.length,
        origins: storageState.origins.length,
        url: safePageUrl(page),
        phase: "done",
        reason: completion.reason,
        blockerResolutionWarning,
        errorMessage: undefined,
    });

    return {
        storageStatePath,
        cookies: storageState.cookies.length,
        origins: storageState.origins.length,
        reason: completion.reason,
        blockersResolved,
        storageState,
        persisted,
        blockerResolutionWarning,
    };
}
