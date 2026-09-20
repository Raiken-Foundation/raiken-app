/**
 * Injectable runtime for Playwright CLI subprocess spawning.
 *
 * Tests inject a fake platform instead of mutating `process.platform`.
 */

export type PlatformId = "win32" | "posix";

export interface PlaywrightSubprocessRuntime {
    platform: PlatformId;
    /** Resolve the executable passed to `spawn` for the given shell mode. */
    resolveCommand(options: { shell: boolean }): string;
    /** Whether the child should be spawned detached (POSIX process groups). */
    spawnDetached: boolean;
}

export function createPlaywrightSubprocessRuntime(
    platform: NodeJS.Platform = process.platform,
): PlaywrightSubprocessRuntime {
    const isWin = platform === "win32";
    return {
        platform: isWin ? "win32" : "posix",
        resolveCommand({ shell }) {
            // Without a shell on Windows, Node requires the `.cmd` shim for `npx`.
            if (isWin && !shell) return "npx.cmd";
            // With `shell: true`, `npx` resolves via cmd.exe on Windows and sh on POSIX.
            return "npx";
        },
        spawnDetached: !isWin,
    };
}

export const defaultPlaywrightSubprocessRuntime = (): PlaywrightSubprocessRuntime =>
    createPlaywrightSubprocessRuntime(process.platform);

/**
 * Spawn options used by {@link TestRunner} (JSON reporter).
 *
 * Spawned without a shell: `args` carries caller-supplied spec paths, and a
 * shell would let a path containing `;` or backticks run arbitrary commands.
 */
export function runnerPlaywrightSpawnOptions(base: {
    cwd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutGraceMs?: number;
    runtime?: PlaywrightSubprocessRuntime;
}) {
    const runtime = base.runtime ?? defaultPlaywrightSubprocessRuntime();
    return {
        ...base,
        runtime,
        shell: false as const,
        command: runtime.resolveCommand({ shell: false }),
    };
}

/** Spawn options used by custom login (line reporter, no shell, secret-safe). */
export function customLoginPlaywrightSpawnOptions(base: {
    cwd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutGraceMs?: number;
    runtime?: PlaywrightSubprocessRuntime;
}) {
    // Identical to the runner options — one implementation, two names
    // (review finding: the bodies were byte-identical copies that would
    // drift).
    return runnerPlaywrightSpawnOptions(base);
}
