/**
 * `raiken eval` — run agent eval scenarios and report scored results.
 *
 * Suites:
 *   - `playground`: ground-truth scenarios against the repo's fixture apps
 *     (crawler/route discovery, auth-wall detection). No LLM key needed.
 *     Intended to run from the raiken repo root (or pass --dir).
 *   - `benchmark`: accuracy regression gates against the full
 *     `tools/playground-auth` fixture — blocker layering, resumed crawls,
 *     authenticated route recall, modal selector grounding, auth
 *     preconditions. No LLM key needed; also expects the repo root.
 *   - `flakiness <testFile>`: project-agnostic — runs one spec N times against
 *     the current project and scores run-to-run stability.
 *
 * Exit codes: 0 all scenarios passed (or skipped), 2 bad arguments, and
 * otherwise the shared CLI_EXIT policy — 1 for a scenario or harness failure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { CLI_EXIT, cliExitForRuntimeFailure } from "../errors";
import { cliExit } from "../repl/exit";

export interface EvalCommandOptions {
    repeat?: string;
    filter?: string;
    runs?: string;
    expectTests?: string;
    dir?: string;
    out?: string;
    json?: boolean;
    keepWorkDirs?: boolean;
}

export async function evalCommand(
    suite: string,
    target: string | undefined,
    options: EvalCommandOptions,
): Promise<void> {
    if (!["playground", "benchmark", "flakiness"].includes(suite)) {
        console.error(
            chalk.red(
                `Unknown eval suite "${suite}". Available: playground, benchmark, flakiness.`,
            ),
        );
        return cliExit(CLI_EXIT.USAGE);
    }
    if (suite === "flakiness" && !target) {
        console.error(chalk.red("usage: raiken eval flakiness <testFile> [--runs N]"));
        return cliExit(CLI_EXIT.USAGE);
    }

    const {
        buildBenchmarkScenarios,
        buildFlakinessScenario,
        buildPlaygroundScenarios,
        formatEvalReport,
        runEvalScenarios,
        silenceCrawleeLogging,
    } = await import("@raiken/core");
    const projectPath = process.cwd();

    // Crawlee's own logger (used internally by the playground scenarios'
    // SiteDiscovery target) writes straight to stdout at INFO by default,
    // regardless of anything passed to our harness — left alone, it
    // interleaves with (and corrupts) the JSON this mode is supposed to
    // emit as the only thing on stdout. Silence it for `--json`; humans
    // reading the normal report still see per-attempt Crawlee progress.
    if (options.json) await silenceCrawleeLogging();

    // biome-ignore lint/suspicious/noExplicitAny: scenarios are heterogeneous by design; each is internally type-safe
    let scenarios: any[];
    if (suite === "playground") {
        const root = path.resolve(options.dir ?? path.join(projectPath, "tools"));
        scenarios = buildPlaygroundScenarios({
            playgroundDir: path.join(root, "playground"),
            authPlaygroundDir: path.join(root, "playground-auth"),
        });
    } else if (suite === "benchmark") {
        const root = path.resolve(options.dir ?? path.join(projectPath, "tools"));
        scenarios = buildBenchmarkScenarios({
            authPlaygroundDir: path.join(root, "playground-auth"),
        });
    } else {
        // Comparing run-to-run stability needs at least two runs. Silently
        // rounding `--runs 1` up to 2 would report a gate the user never asked
        // for, so reject it instead.
        const runs = options.runs === undefined ? 3 : parsePositiveInt(options.runs);
        if (runs === null || runs < 2) {
            console.error(
                chalk.red(
                    `--runs must be an integer of 2 or more — stability needs at least two runs to compare. Got "${options.runs}".`,
                ),
            );
            return cliExit(CLI_EXIT.USAGE);
        }

        const expectedTests =
            options.expectTests === undefined ? undefined : parsePositiveInt(options.expectTests);
        if (expectedTests === null) {
            console.error(
                chalk.red(
                    `--expect-tests must be a positive integer; got "${options.expectTests}".`,
                ),
            );
            return cliExit(CLI_EXIT.USAGE);
        }

        scenarios = [
            buildFlakinessScenario({
                projectPath,
                testFile: target,
                runs,
                ...(expectedTests === undefined ? {} : { expectedTests }),
            }),
        ];
    }

    const repeat = options.repeat === undefined ? 1 : parsePositiveInt(options.repeat);
    if (repeat === null) {
        console.error(chalk.red(`--repeat must be a positive integer; got "${options.repeat}".`));
        return cliExit(CLI_EXIT.USAGE);
    }

    const report = await runEvalScenarios(scenarios, {
        repeat,
        filter: options.filter,
        keepWorkDirs: options.keepWorkDirs,
        log: options.json ? undefined : (message) => console.log(chalk.dim(message)),
    });

    if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    }

    if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        const rendered = formatEvalReport(report);
        console.log(report.passed ? rendered : chalk.red(rendered));
    }

    cliExit(cliExitForRuntimeFailure(report.passed));
}

/**
 * Parse a positive-integer option. Returns null when absent or unparseable so
 * callers reject bad input rather than silently substituting a default.
 */
function parsePositiveInt(raw: string | undefined): number | null {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
}
