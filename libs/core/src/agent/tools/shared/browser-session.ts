import { BrowserSession } from "../../../browser/session";
import {
    resolveAuthStorageStateDestination,
    resolveUsableAuthStorageStatePath,
} from "../../../config";
import type { AuthPrecondition } from "../../graph/utils";
import { AgentMemory } from "../../memory";

export function resolveBrowserAuthStatePath(
    projectPath: string,
    precondition: AuthPrecondition,
): string | undefined {
    return precondition === "authenticated"
        ? (resolveUsableAuthStorageStatePath(projectPath) ?? undefined)
        : undefined;
}

/**
 * Get a BrowserSession pre-bound to the project's persistent selector memory
 * so every click/fill/hover records its outcome in `selector_history`.
 *
 * Use this everywhere instead of `BrowserSession.getInstance(projectPath)`
 * so the compounding selector value actually accrues.
 */
export function getBoundBrowserSession(projectPath: string): BrowserSession {
    const session = BrowserSession.getInstance(projectPath);
    const memory = AgentMemory.getInstance(projectPath);
    session.setSelectorMemory(memory.asSelectorMemory());
    return session;
}

/**
 * Single source of truth for the headless flag. `RAIKEN_HEADLESS` (set to
 * "1"/"true" or "0"/"false") always wins so CI can force headless and the
 * interactive REPL can force headed, regardless of a call site's preference.
 * Otherwise the caller's `preferred` value is used (defaulting to headed so
 * the user can watch the agent work).
 */
export function resolveHeadless(preferred = false): boolean {
    const env = process.env["RAIKEN_HEADLESS"];
    if (env !== undefined) {
        if (/^(1|true|yes)$/i.test(env)) return true;
        if (/^(0|false|no)$/i.test(env)) return false;
    }
    return preferred;
}

const browserAuthPreconditions = new WeakMap<BrowserSession, AuthPrecondition>();

/** @internal Exported for deterministic auth-context regression tests. */
export async function ensureBrowserStarted(
    session: BrowserSession,
    projectPath: string,
    getAuthPrecondition: () => AuthPrecondition,
    preferredHeadless = false,
    forceRestart = false,
): Promise<void> {
    const precondition = getAuthPrecondition();
    const previousPrecondition = browserAuthPreconditions.get(session);
    if (
        session.isActive() &&
        (forceRestart ||
            previousPrecondition === undefined ||
            previousPrecondition !== precondition)
    ) {
        await session.close();
    }
    if (!session.isActive()) {
        const storageStatePath = resolveBrowserAuthStatePath(projectPath, precondition);
        await session.start({ headless: resolveHeadless(preferredHeadless), storageStatePath });
        browserAuthPreconditions.set(session, precondition);
    }
}

export function clearBrowserAuthPrecondition(session: BrowserSession): void {
    browserAuthPreconditions.delete(session);
}

export { resolveAuthStorageStateDestination };
