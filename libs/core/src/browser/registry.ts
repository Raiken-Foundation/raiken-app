import * as fs from "node:fs";
import * as path from "node:path";
import { BrowserSession } from "./session";

export interface BrowserSessionLease {
    session: BrowserSession;
    release(options?: { forceClose?: boolean }): Promise<void>;
}

interface LeaseState {
    refs: number;
}

const sessions = new Map<string, BrowserSession>();
const leases = new Map<string, LeaseState>();

function canonicalProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
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
    const key = canonicalProjectPath(projectPath);
    let session = sessions.get(key);
    if (!session) {
        session = createBrowserSession(projectPath);
        sessions.set(key, session);
    }
    return session;
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
    if (signal?.aborted) {
        throw new DOMException("Operation cancelled", "AbortError");
    }

    const key = canonicalProjectPath(projectPath);
    const session = getOrCreateBrowserSession(projectPath);
    const state = leases.get(key) ?? { refs: 0 };
    state.refs++;
    leases.set(key, state);

    let released = false;
    const releaseOnce = async (options?: { forceClose?: boolean }) => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        await releaseBrowserSessionLease(projectPath, options);
    };

    const onAbort = () => {
        void releaseOnce({ forceClose: true });
    };

    if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
    }

    return {
        session,
        release: releaseOnce,
    };
}

export async function releaseBrowserSessionLease(
    projectPath: string,
    options?: { forceClose?: boolean },
): Promise<void> {
    const key = canonicalProjectPath(projectPath);

    if (options?.forceClose) {
        leases.delete(key);
        const session = sessions.get(key);
        if (session) {
            await session.close().catch(() => undefined);
        }
        return;
    }

    const state = leases.get(key);
    if (!state) return;

    state.refs = Math.max(0, state.refs - 1);
    if (state.refs === 0) {
        leases.delete(key);
    } else {
        leases.set(key, state);
    }
}

/** Close every registered browser session (process shutdown). */
export async function closeAllBrowserSessions(): Promise<void> {
    leases.clear();
    await Promise.all(
        [...sessions.values()].map((session) => session.close().catch(() => undefined)),
    );
}

/** Close and discard every registered browser session (tests). */
export async function resetBrowserRegistry(): Promise<void> {
    leases.clear();
    await Promise.all(
        [...sessions.values()].map((session) => session.close().catch(() => undefined)),
    );
    sessions.clear();
}
