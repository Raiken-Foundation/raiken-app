/**
 * `raiken eval` — run agent eval scenarios and report scored results.
 *
 * Suites:
 *   - `playground`: ground-truth scenarios against the repo's fixture apps
 *     (crawler/route discovery, auth-wall detection). No LLM key needed.
 *     Intended to run from the raiken repo root (or pass --dir).
 *   - `flakiness <testFile>`: project-agnostic — runs one spec N times against
 *     the current project and scores run-to-run stability.
 *
 * Exit codes: 0 all scenarios passed (or skipped), 1 something failed,
 * 2 the harness itself errored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { cliExit } from "../repl/exit";

export interface EvalCommandOptions {
    repeat?: string;
    filter?: string;
    runs?: string;
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
    const {
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
    } else if (suite === "flakiness") {
        if (!target) {
            console.error(chalk.red("usage: raiken eval flakiness <testFile> [--runs N]"));
            return cliExit(2);
        }
        scenarios = [
            buildFlakinessScenario({
                projectPath,
                testFile: target,
                runs: parseCount(options.runs, 3),
            }),
        ];
    } else {
        console.error(
            chalk.red(`Unknown eval suite "${suite}". Available: playground, flakiness.`),
        );
        return cliExit(2);
    }

    const report = await runEvalScenarios(scenarios, {
        repeat: parseCount(options.repeat, 1),
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

    cliExit(report.passed ? 0 : 1);
}

function parseCount(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
