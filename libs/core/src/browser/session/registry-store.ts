import * as fs from "node:fs";
import * as path from "node:path";

export interface RegisteredBrowserSession {
    close(): Promise<void>;
}

export interface RegisteredBrowserSessionLease<TSession extends RegisteredBrowserSession> {
    session: TSession;
    release(options?: { forceClose?: boolean }): Promise<void>;
}

interface LeaseState {
    refs: number;
}

const sessions = new Map<string, RegisteredBrowserSession>();
const leases = new Map<string, LeaseState>();

function canonicalProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

export function getOrCreateRegisteredBrowserSession<TSession extends RegisteredBrowserSession>(
    projectPath: string,
    create: (projectPath: string) => TSession,
): TSession {
    const key = canonicalProjectPath(projectPath);
    let session = sessions.get(key) as TSession | undefined;
    if (!session) {
        session = create(projectPath);
        sessions.set(key, session);
    }
    return session;
}

export function acquireRegisteredBrowserSessionLease<TSession extends RegisteredBrowserSession>(
    projectPath: string,
    create: (projectPath: string) => TSession,
    signal?: AbortSignal,
): RegisteredBrowserSessionLease<TSession> {
    if (signal?.aborted) {
        throw new DOMException("Operation cancelled", "AbortError");
    }

    const key = canonicalProjectPath(projectPath);
    const session = getOrCreateRegisteredBrowserSession(projectPath, create);
    const state = leases.get(key) ?? { refs: 0 };
    state.refs++;
    leases.set(key, state);

    let released = false;
    const releaseOnce = async (options?: { forceClose?: boolean }) => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        await releaseRegisteredBrowserSessionLease(projectPath, options);
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

export async function releaseRegisteredBrowserSessionLease(
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
export async function closeRegisteredBrowserSessions(): Promise<void> {
    leases.clear();
    await Promise.all(
        [...sessions.values()].map((session) => session.close().catch(() => undefined)),
    );
}

/** Close and discard every registered browser session (tests). */
export async function resetRegisteredBrowserSessions(): Promise<void> {
    leases.clear();
    await Promise.all(
        [...sessions.values()].map((session) => session.close().catch(() => undefined)),
    );
    sessions.clear();
}
