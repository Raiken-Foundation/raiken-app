import { spawn } from "node:child_process";
import {
    defaultPlaywrightSubprocessRuntime,
    type PlaywrightSubprocessRuntime,
} from "./playwright-subprocess-runtime";
import { killProcessTree } from "./process-tree";

export type {
    PlatformId,
    PlaywrightSubprocessRuntime,
} from "./playwright-subprocess-runtime";
export {
    createPlaywrightSubprocessRuntime,
    customLoginPlaywrightSpawnOptions,
    defaultPlaywrightSubprocessRuntime,
    runnerPlaywrightSpawnOptions,
} from "./playwright-subprocess-runtime";

export interface PlaywrightSubprocessOptions {
    /** Working directory for the Playwright CLI invocation. */
    cwd: string;
    /** Arguments passed to `npx` after the command name (e.g. `playwright`, `test`, …). */
    args: string[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Hard limit after which the process tree is terminated. */
    timeoutMs?: number;
    /**
     * Extra grace period added to `timeoutMs` before the watchdog fires.
     * Defaults to 5000 ms so Playwright can flush reporters.
     */
    timeoutGraceMs?: number;
    /** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
    killGraceMs?: number;
    /** Use a shell wrapper for cross-platform `npx` resolution. Default true. */
    shell?: boolean;
    /** Override the spawn command. Defaults via {@link PlaywrightSubprocessRuntime}. */
    command?: string;
    /** Injectable platform/runtime resolution (defaults to `process.platform`). */
    runtime?: PlaywrightSubprocessRuntime;
    /** When false, stdout/stderr are only forwarded to callbacks. Default true. */
    captureOutput?: boolean;
    /**
     * Attach the child to this process's TTY (stdio inherit) for interactive
     * tools like `playwright test --debug` or `show-trace`. Implies
     * `captureOutput: false`; stdout/stderr in the result stay empty.
     */
    interactive?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
}

export interface PlaywrightSubprocessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cancelled: boolean;
    timedOut: boolean;
    spawnError?: Error;
}

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;

/**
 * Run Playwright CLI as a managed subprocess with detached process-group killing,
 * abort/timeout settlement guards, and optional output capture.
 */
export function runPlaywrightSubprocess(
    options: PlaywrightSubprocessOptions,
): Promise<PlaywrightSubprocessResult> {
    const runtime = options.runtime ?? defaultPlaywrightSubprocessRuntime();
    const {
        cwd,
        args,
        env = process.env,
        signal,
        timeoutMs,
        timeoutGraceMs = DEFAULT_TIMEOUT_GRACE_MS,
        killGraceMs = DEFAULT_KILL_GRACE_MS,
        shell = true,
        command = runtime.resolveCommand({ shell }),
        captureOutput = true,
        interactive = false,
        onStdout,
        onStderr,
    } = options;

    if (signal?.aborted) {
        return Promise.resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            cancelled: true,
            timedOut: false,
        });
    }

    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            shell,
            detached: runtime.spawnDetached,
            env,
            stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const appendStdout = (chunk: string) => {
            if (captureOutput) stdout += chunk;
            onStdout?.(chunk);
        };
        const appendStderr = (chunk: string) => {
            if (captureOutput) stderr += chunk;
            onStderr?.(chunk);
        };

        child.stdout?.on("data", (data) => appendStdout(data.toString()));
        child.stderr?.on("data", (data) => appendStderr(data.toString()));

        const terminateProcessTree = () => {
            if (!child.pid) return;
            // Descendants found now are re-signaled on SIGKILL escalation:
            // once the root is dead, reparented orphans (e.g. Playwright's
            // detached webServer) can no longer be discovered from it.
            const descendants = killProcessTree(child.pid, "SIGTERM");
            killTimer = setTimeout(() => {
                if (child.pid) killProcessTree(child.pid, "SIGKILL", descendants);
            }, killGraceMs);
            killTimer.unref?.();
        };

        const settle = (result: PlaywrightSubprocessResult) => {
            if (settled) return;
            settled = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (killTimer) clearTimeout(killTimer);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };

        const onAbort = () => {
            terminateProcessTree();
            settle({
                exitCode: null,
                stdout,
                stderr,
                cancelled: true,
                timedOut: false,
            });
        };

        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        if (typeof timeoutMs === "number" && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                terminateProcessTree();
                settle({
                    exitCode: null,
                    stdout,
                    stderr,
                    cancelled: false,
                    timedOut: true,
                });
            }, timeoutMs + timeoutGraceMs);
        }

        child.once("error", (error) => {
            settle({
                exitCode: null,
                stdout,
                stderr,
                cancelled: false,
                timedOut: false,
                spawnError: error,
            });
        });

        child.once("close", (code) => {
            settle({
                exitCode: code,
                stdout,
                stderr,
                cancelled: false,
                timedOut: false,
            });
        });

        if (signal?.aborted) onAbort();
    });
}

/** Strip `PLAYWRIGHT_JSON_OUTPUT_NAME` so JSON reporter writes to stdout. */
export function playwrightJsonReporterEnv(
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env = { ...base };
    delete env["PLAYWRIGHT_JSON_OUTPUT_NAME"];
    return env;
}
