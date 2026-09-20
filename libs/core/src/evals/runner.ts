/**
 * Eval runner: executes scenarios attempt-by-attempt with isolated work
 * directories and guaranteed target teardown, and aggregates pass rates.
 *
 * LLM-backed scenarios are nondeterministic — run them with `repeat > 1`
 * and read `passRate` as the signal, not any single attempt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
    EvalAttemptContext,
    EvalAttemptResult,
    EvalReport,
    EvalScenario,
    EvalScore,
    RunEvalOptions,
    ScenarioReport,
} from "./types";

export async function runEvalScenarios(
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous scenario outputs; each scenario is internally type-safe
    scenarios: Array<EvalScenario<any>>,
    options: RunEvalOptions = {},
): Promise<EvalReport> {
    const startedAt = Date.now();
    const repeat = options.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1)
        throw new Error("Eval repeat must be a positive integer");
    const log = options.log ?? (() => {});

    const selected = options.filter
        ? scenarios.filter((scenario) => scenario.id.includes(options.filter ?? ""))
        : scenarios;

    const reports: ScenarioReport[] = [];
    for (const scenario of selected) {
        reports.push(await runScenario(scenario, repeat, log, options.keepWorkDirs ?? false));
    }

    return {
        startedAt,
        durationMs: Date.now() - startedAt,
        repeat,
        scenarios: reports,
        passed:
            reports.length > 0 &&
            reports.every((report) => report.skipped === undefined && report.passRate === 1),
    };
}

async function runScenario(
    scenario: EvalScenario<unknown>,
    repeat: number,
    log: (message: string) => void,
    keepWorkDirs: boolean,
): Promise<ScenarioReport> {
    const missingEnv = (scenario.requiresEnv ?? []).filter((name) => !process.env[name]);
    if (missingEnv.length > 0) {
        const reason = `requires env: ${missingEnv.join(", ")}`;
        log(`○ ${scenario.id} skipped (${reason})`);
        return {
            id: scenario.id,
            description: scenario.description,
            skipped: reason,
            attempts: [],
            passRate: 0,
        };
    }

    const attempts: EvalAttemptResult[] = [];
    for (let attempt = 1; attempt <= repeat; attempt++) {
        log(`▸ ${scenario.id} attempt ${attempt}/${repeat}`);
        const result = await runAttempt(scenario, attempt, log, keepWorkDirs);
        attempts.push(result);
        const mark = result.passed ? "✓" : "✗";
        const failing = result.scores.filter((score) => !score.passed);
        log(
            `${mark} ${scenario.id} attempt ${attempt} (${result.durationMs}ms)` +
                (result.error
                    ? ` — error: ${result.error}`
                    : failing.length > 0
                      ? ` — failed: ${failing.map((score) => score.name).join(", ")}`
                      : ""),
        );
    }

    return {
        id: scenario.id,
        description: scenario.description,
        attempts,
        passRate: attempts.filter((attempt) => attempt.passed).length / attempts.length,
    };
}

async function runAttempt(
    scenario: EvalScenario<unknown>,
    attempt: number,
    log: (message: string) => void,
    keepWorkDir: boolean,
): Promise<EvalAttemptResult> {
    const startedAt = Date.now();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `raiken-eval-${scenario.id}-`));
    const target = scenario.createTarget?.() ?? null;
    const scores: EvalScore[] = [];
    let error: string | undefined;

    try {
        let baseUrl: string | null = null;
        if (target) {
            baseUrl = (await target.start()).baseUrl;
            log(`  target "${target.name}" at ${baseUrl}`);
        }
        const ctx: EvalAttemptContext = {
            workDir,
            baseUrl,
            log: (message) => log(`  ${message}`),
        };

        const output = await scenario.run(ctx);

        for (const scorer of scenario.scorers) {
            try {
                scores.push(await scorer.score(output, ctx));
            } catch (scorerError) {
                scores.push({
                    name: scorer.name,
                    passed: false,
                    detail: `scorer threw: ${
                        scorerError instanceof Error ? scorerError.message : scorerError
                    }`,
                });
            }
        }
    } catch (runError) {
        error = runError instanceof Error ? runError.message : String(runError);
    } finally {
        try {
            await target?.stop();
        } catch {
            // Teardown failures shouldn't mask the attempt result.
        }
        if (!keepWorkDir) {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    }

    return {
        attempt,
        passed: error === undefined && scores.length > 0 && scores.every((score) => score.passed),
        scores,
        ...(error ? { error } : {}),
        durationMs: Date.now() - startedAt,
    };
}
