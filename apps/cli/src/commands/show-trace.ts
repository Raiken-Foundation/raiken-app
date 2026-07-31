/**
 * `raiken show-trace [path]` — open a Playwright trace.zip in the trace
 * viewer. The generated config captures `trace: 'on-first-retry'`, so a
 * retried failure leaves one under test-results/ — this is the shortest path
 * to it from the terminal. With no argument, opens the newest trace.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runPlaywrightSubprocess } from "@raiken/core";
import chalk from "chalk";
import { dim } from "../agent-stream";
import { CLI_EXIT } from "../errors";
import { cliExit } from "../repl/exit";

interface ShowTraceOptions {
    json?: boolean;
}

/** Newest trace.zip under test-results/ (playwright's default outputDir). */
async function findLatestTrace(projectPath: string): Promise<string | null> {
    const root = path.join(projectPath, "test-results");
    const candidates: Array<{ file: string; mtimeMs: number }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6) return;
        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
            } else if (entry.isFile() && entry.name === "trace.zip") {
                const stat = await fs.stat(full).catch(() => null);
                if (stat) candidates.push({ file: full, mtimeMs: stat.mtimeMs });
            }
        }
    };
    await walk(root, 0);

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.file ?? null;
}

export async function showTraceCommand(
    tracePath: string | undefined,
    options: ShowTraceOptions,
): Promise<void> {
    const projectPath = process.cwd();

    let resolved: string | null = null;
    if (tracePath) {
        const candidate = path.isAbsolute(tracePath)
            ? tracePath
            : path.join(projectPath, tracePath);
        try {
            await fs.access(candidate);
            resolved = candidate;
        } catch {
            const message = `Trace not found: ${tracePath}`;
            if (options.json) {
                process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
            } else {
                console.log(chalk.red(`  ${message}`));
            }
            cliExit(1);
        }
    } else {
        resolved = await findLatestTrace(projectPath);
        if (!resolved) {
            const message =
                "No trace.zip found under test-results/. Playwright only writes one when " +
                "`trace` is enabled in playwright.config ('on', 'retain-on-failure', or " +
                "'on-first-retry') — enable it and re-run a failing test.";
            if (options.json) {
                process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
            } else {
                console.log(dim(`  ${message}`));
            }
            cliExit(1);
        }
    }

    if (!options.json) {
        process.stderr.write(dim(`  Opening ${path.relative(projectPath, resolved)}…\n`));
    }

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const result = await runPlaywrightSubprocess({
        cwd: projectPath,
        args: ["playwright", "show-trace", resolved],
        interactive: true,
        signal: controller.signal,
    });

    if (result.spawnError) {
        const message = `Could not start the trace viewer: ${result.spawnError.message}`;
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
        } else {
            console.log(chalk.red(`  ${message}`));
        }
        cliExit(1);
    }
    cliExit(result.cancelled ? CLI_EXIT.CANCELLED : (result.exitCode ?? 0));
}
