/**
 * `raiken trace` — given a stack trace, surface the existing tests in the
 * graph that most directly cover the implicated code. Reverse of
 * `raiken ci`'s impact query.
 *
 * Input sources, in priority order:
 *   1. --file <path>    Read the trace from a file
 *   2. positional arg   Treat as the trace text directly
 *   3. stdin            Read from a pipe (e.g. `cat err.log | raiken trace`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { queryTrace, type TraceResult } from "@raiken/core";
import chalk from "chalk";
import { CLI_EXIT } from "../errors";
import { cliExit } from "../repl/exit";

interface TraceCommandOptions {
    file?: string;
    minConfidence?: string;
    limit?: string;
    json?: boolean;
}

export async function traceCommand(
    traceArg: string | undefined,
    options: TraceCommandOptions,
): Promise<void> {
    const projectPath = process.cwd();
    const trace = await resolveTraceInput(traceArg, options.file);

    if (!trace.trim()) {
        console.error(
            chalk.red(
                "No stack trace provided. Pass --file <path>, a positional arg, or pipe via stdin.",
            ),
        );
        cliExit(CLI_EXIT.USAGE);
    }

    // Guard against non-numeric / out-of-range CLI input (e.g. `--limit abc`
    // would otherwise become NaN and silently break the query).
    const parsedConfidence = options.minConfidence ? Number(options.minConfidence) : 0;
    const minConfidence =
        Number.isFinite(parsedConfidence) && parsedConfidence >= 0
            ? Math.min(parsedConfidence, 1)
            : 0;
    const parsedLimit = options.limit ? Number(options.limit) : 20;
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;

    if (!options.json) {
        console.log(chalk.cyan("\nraiken trace\n"));
    }

    const result = await queryTrace({
        projectPath,
        trace,
        minConfidence,
        limit,
    });

    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        cliExit(result.matches.length === 0 ? 1 : 0);
    }

    printHumanResult(result);
    cliExit(result.matches.length === 0 ? 1 : 0);
}

async function resolveTraceInput(
    positional: string | undefined,
    filePath: string | undefined,
): Promise<string> {
    if (filePath) {
        const abs = path.resolve(process.cwd(), filePath);
        return fs.readFileSync(abs, "utf-8");
    }
    if (positional && positional.trim().length > 0) {
        return positional;
    }
    if (!process.stdin.isTTY) {
        return await readStdin();
    }
    return "";
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c) => chunks.push(c));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        process.stdin.on("error", reject);
    });
}

function printHumanResult(result: TraceResult): void {
    console.log(
        chalk.dim(
            `Parsed ${result.frames.length} frame(s); ${result.projectFrames.length} resolved into project files.`,
        ),
    );

    if (result.projectFrames.length === 0) {
        console.log();
        console.log(
            chalk.yellow(
                "⚠ None of the trace frames map to files in this project. " +
                    "Check that you're running from the right repo, or that the trace " +
                    "isn't entirely from node_modules / browser internals.",
            ),
        );
        return;
    }

    console.log();
    console.log(chalk.bold("Implicated source files:"));
    for (const f of result.projectFrames.slice(0, 8)) {
        const loc = f.line ? `:${f.line}` : "";
        console.log(`  ${chalk.dim("·")} ${f.resolvedPath}${chalk.dim(loc)}`);
    }
    if (result.projectFrames.length > 8) {
        console.log(chalk.dim(`  …and ${result.projectFrames.length - 8} more`));
    }
    console.log();

    if (result.matches.length === 0) {
        console.log(
            chalk.yellow(
                "No existing tests cover these files. Consider running " +
                    `${chalk.bold("raiken cover")} to draft one.`,
            ),
        );
        return;
    }

    console.log(chalk.bold("Tests most likely to reproduce this:"));
    console.log();
    for (const m of result.matches) {
        const conf = m.confidence.toFixed(2);
        console.log(`  ${chalk.green(conf)}  ${chalk.bold(m.testFile)}`);
        for (const frame of m.matchedFrames.slice(0, 3)) {
            console.log(chalk.dim(`         via ${frame}`));
        }
        if (m.matchedFrames.length > 3) {
            console.log(chalk.dim(`         + ${m.matchedFrames.length - 3} more`));
        }
    }
    console.log();
    console.log(
        chalk.dim(
            `Tip: rerun the top match locally to confirm reproduction:` +
                `\n      npx playwright test ${result.matches[0].testFile}`,
        ),
    );
}
