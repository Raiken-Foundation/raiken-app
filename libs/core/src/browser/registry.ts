import { BrowserSession } from "./session";
import {
    acquireRegisteredBrowserSessionLease,
    closeRegisteredBrowserSessions,
    getOrCreateRegisteredBrowserSession,
    releaseRegisteredBrowserSessionLease,
    resetRegisteredBrowserSessions,
} from "./session/registry-store";

export interface BrowserSessionLease {
    session: BrowserSession;
    release(options?: { forceClose?: boolean }): Promise<void>;
}

/** @internal Factory hook for the canonical-project registry. */
export function createBrowserSession(projectPath: string): BrowserSession {
    return BrowserSession.__create(projectPath);
}

/**
 * Return the browser session for a canonical project path, creating one if needed.
 * Preserves legacy {@link BrowserSession.getInstance} semantics per project.
 */
export function getOrCreateBrowserSession(projectPath: string): BrowserSession {
    return getOrCreateRegisteredBrowserSession(projectPath, createBrowserSession);
}

/**
 * Acquire a lease on the project's browser session. Normal {@link BrowserSessionLease.release}
 * drops the lease without closing the browser (REPL reuse). Pass `forceClose: true` or abort
 * the linked signal to shut the browser down promptly.
 */
export function acquireBrowserSessionLease(
    projectPath: string,
    signal?: AbortSignal,
): BrowserSessionLease {
    return acquireRegisteredBrowserSessionLease(projectPath, createBrowserSession, signal);
}

export async function releaseBrowserSessionLease(
    projectPath: string,
    options?: { forceClose?: boolean },
): Promise<void> {
    await releaseRegisteredBrowserSessionLease(projectPath, options);
}

/** Close every registered browser session (process shutdown). */
export async function closeAllBrowserSessions(): Promise<void> {
    await closeRegisteredBrowserSessions();
}

/** Close and discard every registered browser session (tests). */
export async function resetBrowserRegistry(): Promise<void> {
    await resetRegisteredBrowserSessions();
}
