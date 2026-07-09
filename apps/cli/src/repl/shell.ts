/**
 * Shell escape for the REPL — Claude-style `!command`.
 *
 * Runs in the project cwd, streams output to the terminal, and returns a
 * compact summary the caller can optionally inject into conversation context.
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import { dim } from "../agent-stream";

export interface ShellResult {
    command: string;
    code: number | null;
    stdout: string;
    stderr: string;
}

const OUTPUT_CAP = 8_000;

/**
 * Run a shell command. Output is written live to stdout/stderr; the returned
 * buffers are capped so a runaway `find /` can't blow memory.
 */
export function runShellCommand(
    command: string,
    cwd: string,
    options: { timeoutMs?: number } = {},
): Promise<ShellResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise((resolve) => {
        const child = spawn(command, {
            cwd,
            shell: true,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, timeoutMs);
        timer.unref();

        child.stdout?.on("data", (buf: Buffer) => {
            const chunk = buf.toString("utf-8");
            process.stdout.write(chunk);
            if (stdout.length < OUTPUT_CAP) stdout += chunk.slice(0, OUTPUT_CAP - stdout.length);
        });
        child.stderr?.on("data", (buf: Buffer) => {
            const chunk = buf.toString("utf-8");
            process.stderr.write(chunk);
            if (stderr.length < OUTPUT_CAP) stderr += chunk.slice(0, OUTPUT_CAP - stderr.length);
        });

        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ command, code, stdout, stderr });
        };

        child.on("error", (err) => {
            process.stderr.write(chalk.red(`  ✗ ${err.message}\n`));
            finish(1);
        });
        child.on("close", (code) => finish(code));
    });
}

/** Print a one-line exit summary after a shell command. */
export function printShellSummary(result: ShellResult): void {
    const code = result.code ?? 1;
    if (code === 0) {
        console.log(dim(`  ✓ exit ${code}`));
    } else {
        console.log(chalk.yellow(`  ⚠ exit ${code}`));
    }
}
