/**
 * `raiken repair [file]` — the dashboard's interpret → repair → diff-review
 * loop, on the terminal. Runs the spec (or takes the run `raiken test --fix`
 * just produced), asks the AI for a corrected test, shows a unified diff,
 * and writes it only after an explicit yes — same review gate as the
 * dashboard's "Apply fix".
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    createProjectApplication,
    describeGroundingViolations,
    extractOrigins,
    gatherRepairEvidence,
    getProvider,
    resolveAIConfig,
    validateSelectorGrounding,
} from "@raiken/core";
import chalk from "chalk";
import { dim, routeDiagnosticsToStderr } from "../agent-stream";
import { formatUnifiedDiff } from "../diff";
import { CLI_EXIT, exitUsage } from "../errors";
import { cliExit } from "../repl/exit";

export interface RepairCommandOptions {
    /** Write the fix without prompting (scripts / CI). */
    apply?: boolean;
    json?: boolean;
    /** Skip the interpretation step (repair still works, just colder). */
    interpret?: boolean;
    /**
     * Re-run the spec after writing the fix (default). `--no-verify` skips
     * the run for callers who only want the diff applied.
     */
    verify?: boolean;
    /** REPL-injected prompt (inquirer can't own the terminal there). */
    confirm?: (message: string) => Promise<boolean>;
    /**
     * Run counts from the failed run that triggered this repair (`test
     * --fix`), embedded into the JSON payload under `run`.
     */
    runSummary?: { passed: number; failed: number; skipped: number };
}

/** The slice of a test-run result the repair flow needs. */
export interface RepairRunResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    parsedRun?: {
        tests?: Array<{
            name?: string;
            suite?: string;
            status?: string;
            duration?: number;
            error?: {
                message?: string;
                snippet?: string;
                location?: { file: string; line: number; column: number };
            };
            attachments?: Array<{ name: string; contentType?: string; path?: string }>;
        }>;
    } | null;
}

const RAW_OUTPUT_LIMIT = 6000;

/**
 * Same message the core repair service returns for a missing key — checked
 * here so the flow can exit 3 (config/auth, per the CLI exit contract)
 * instead of 1, matching the one-shot path. Keyless providers (Ollama)
 * return null. Exported for unit tests.
 */
export function missingAiKeyMessage(projectPath: string): string | null {
    const resolved = resolveAIConfig(projectPath);
    const provider = getProvider(resolved.provider);
    if (provider.envVars.length === 0 || resolved.apiKey) return null;
    const keyHint = provider.envVars[0] ?? "an API key";
    return `No API key configured for ${provider.label}. Set ${keyHint} or add it in Settings.`;
}

function composeRawOutput(run: RepairRunResult): string {
    const failures = (run.parsedRun?.tests ?? []).filter((t) => t.status === "failed");
    const parts = failures.map((t) =>
        `${t.name ?? "unknown"}\n${t.error?.message ?? ""}\n${t.error?.snippet ?? ""}`.trim(),
    );
    if (run.stderr?.trim()) parts.push(run.stderr.trim());
    const joined = parts.join("\n\n");
    return joined.length > RAW_OUTPUT_LIMIT ? `${joined.slice(0, RAW_OUTPUT_LIMIT)}\n…` : joined;
}

function emitJson(payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Repair the spec implicated by an already-finished (failed) run. Shared by
 * `raiken repair` (which runs the spec itself first) and `raiken test --fix`
 * (which reuses the run it just did).
 */
export async function repairFailedRun(input: {
    projectPath: string;
    file: string;
    run: RepairRunResult;
    options: RepairCommandOptions;
}): Promise<void> {
    const { projectPath, file, run, options } = input;
    const app = createProjectApplication(projectPath);
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const emit = (payload: Record<string, unknown>): void =>
        emitJson({ ...payload, ...(options.runSummary ? { run: options.runSummary } : {}) });

    const failures = (run.parsedRun?.tests ?? []).filter((t) => t.status === "failed");
    if (failures.length === 0) {
        restore?.();
        const message =
            (run.parsedRun?.tests?.length ?? 0) === 0
                ? "The run executed no tests, so there is no failure to repair. Run `raiken doctor` — the suite is likely broken before specs execute."
                : "No failed tests in the last run — nothing to repair.";
        if (options.json) emit({ repaired: false, filePath: file, error: message });
        else console.log(dim(`  ${message}`));
        cliExit(1);
    }

    // AI work is unavoidable from here — require the key BEFORE spending it on
    // interpret/repair calls, and report config/auth (3), not runtime (1).
    const keyError = missingAiKeyMessage(projectPath);
    if (keyError) {
        restore?.();
        if (options.json) emit({ repaired: false, filePath: file, error: keyError });
        else console.log(chalk.red(`  ${keyError}`));
        cliExit(CLI_EXIT.CONFIG_AUTH);
    }

    let testCode = "";
    try {
        testCode = await fs.readFile(path.resolve(projectPath, file), "utf-8");
    } catch {
        restore?.();
        const message = `Cannot read ${file} from disk — repair needs the spec source.`;
        if (options.json) emit({ repaired: false, filePath: file, error: message });
        else console.log(chalk.red(`  ${message}`));
        cliExit(1);
    }

    const testResults = failures.map((t) => ({
        name: t.name ?? "unknown",
        suite: t.suite ?? file,
        status: "failed" as const,
        ...(typeof t.duration === "number" ? { duration: t.duration } : {}),
        ...(t.error ? { error: t.error } : {}),
        ...(t.attachments ? { attachments: t.attachments } : {}),
    }));
    const rawOutput = composeRawOutput(run);

    // Discovery snapshots, source-markup selectors, and known origins. This is
    // what keeps the fix grounded in the app that exists rather than one the
    // model imagines — and what the post-fix lint below compares against.
    const evidence = await gatherRepairEvidence(projectPath, `${file}\n${testCode}\n${rawOutput}`);

    if (!options.json) {
        process.stderr.write(dim(`\n  Repairing ${file} (${failures.length} failing test(s))…\n`));
        if (evidence.snapshots.length > 0) {
            process.stderr.write(
                dim(
                    `  Using ${evidence.snapshots.length} captured page snapshot(s) as evidence.\n`,
                ),
            );
        }
    }

    let interpretation: string | undefined;
    if (options.interpret !== false) {
        const interpreted = await app.testing.interpretTestResults({
            testResults,
            testCode,
            testFilePath: file,
            rawOutput,
            pageSummaries: evidence.snapshots,
        });
        if (!interpreted.error && interpreted.interpretation.trim()) {
            interpretation = interpreted.interpretation;
            if (!options.json) {
                const preview = interpretation.split("\n").slice(0, 12).join("\n");
                console.log(dim(`\n  Diagnosis\n  ${preview.split("\n").join("\n  ")}`));
            }
        }
    }

    const repair = await app.testing.repairTestResults({
        testResults,
        testCode,
        testFilePath: file,
        rawOutput,
        pageSummaries: evidence.snapshots,
        ...(interpretation ? { interpretation } : {}),
    });

    if (repair.error || !repair.fixedCode) {
        restore?.();
        const message = repair.error ?? "The AI could not produce a corrected test.";
        if (options.json) emit({ repaired: false, filePath: file, error: message });
        else console.log(chalk.red(`  ${message}`));
        cliExit(1);
    }

    if (repair.fixedCode === repair.originalCode) {
        restore?.();
        const message = "The AI proposed no changes to the spec.";
        if (options.json) emit({ repaired: false, applied: false, filePath: file, message });
        else console.log(dim(`  ${message}`));
        cliExit(0);
    }

    // Lint the proposed fix against project evidence BEFORE anyone applies
    // it. A fix may only reference origins the spec or the knowledge DB
    // already knows (a new origin is a hallucinated URL, not a repair), and
    // must not introduce locators the captured pages contradict.
    const originalGrounding = validateSelectorGrounding(
        repair.originalCode ?? testCode,
        evidence.snapshots,
        evidence.sourceSelectors,
    );
    const fixedGrounding = validateSelectorGrounding(
        repair.fixedCode,
        evidence.snapshots,
        evidence.sourceSelectors,
    );
    const introducedContradictions = fixedGrounding.contradictions.filter(
        (violation) =>
            !originalGrounding.contradictions.some(
                (previous) => previous.locator === violation.locator,
            ),
    );
    const knownOrigins = new Set([...evidence.knownOrigins, ...extractOrigins(testCode)]);
    const newOrigins = [...extractOrigins(repair.fixedCode)].filter(
        (origin) => !knownOrigins.has(origin),
    );
    const lintFindings: string[] = [
        ...newOrigins.map(
            (origin) => `the fix navigates to an origin unknown to this project: ${origin}`,
        ),
        ...describeGroundingViolations(introducedContradictions).map(
            (line) => `the fix introduces an ungrounded locator: ${line}`,
        ),
    ];

    if (lintFindings.length > 0) {
        const unattended = options.apply === true && !options.confirm;
        if (options.json || unattended) {
            restore?.();
            const message = `Repair rejected by grounding lint:\n${lintFindings
                .map((finding) => `- ${finding}`)
                .join("\n")}`;
            if (options.json) {
                emit({ repaired: false, applied: false, filePath: file, error: message });
            } else {
                console.log(chalk.red(`  ${message.split("\n").join("\n  ")}`));
            }
            cliExit(1);
        }
        console.log("");
        for (const finding of lintFindings) {
            console.log(chalk.red(`  ✗ ${finding}`));
        }
        console.log(chalk.yellow("  Review the diff below with the findings above in mind."));
    }

    const diff = formatUnifiedDiff(repair.originalCode, repair.fixedCode, {
        fromLabel: `${file} (current)`,
        toLabel: `${file} (proposed)`,
    });

    if (!options.json) {
        console.log("");
        console.log(diff);
        console.log("");
        if (repair.matchFailed) {
            console.log(
                chalk.yellow(
                    "  ⚠ The edit blocks did not match cleanly — this is a full-file rewrite. Review carefully.",
                ),
            );
        } else if (repair.mode === "edits" && repair.editCount) {
            console.log(dim(`  ${repair.editCount} targeted edit(s).`));
        }
    }

    let apply = options.apply === true;
    if (!apply) {
        if (options.confirm) {
            apply = await options.confirm(`Apply this fix to ${file}?`);
        } else if (!process.stdin.isTTY) {
            restore?.();
            exitUsage(
                `Repair produced a fix but cannot prompt for confirmation (stdin is not interactive). Re-run with --apply to write it.`,
            );
        } else {
            const { confirm } = await import("@inquirer/prompts");
            apply = await confirm({ message: `Apply this fix to ${file}?`, default: false });
        }
    }

    if (!apply) {
        restore?.();
        if (options.json) {
            emit({
                repaired: true,
                applied: false,
                filePath: file,
                mode: repair.mode,
                editCount: repair.editCount,
                matchFailed: repair.matchFailed,
                diff: formatUnifiedDiff(repair.originalCode, repair.fixedCode, { plain: true }),
            });
        } else {
            console.log(dim("  Fix discarded — the spec was not changed."));
        }
        cliExit(0);
    }

    const saved = await app.testing.saveFileContent({ filePath: file, content: repair.fixedCode });

    // A repair isn't done when the diff is written — it's done when the spec
    // passes. Re-run it now; in unattended --apply mode a fix that doesn't
    // verify is reverted, because nobody reviewed the diff and a broken "fix"
    // is strictly worse than the original failure (it lies about the state).
    let verified: boolean | undefined;
    let reverted = false;
    if (options.verify !== false) {
        if (!options.json) {
            process.stderr.write(dim(`\n  Verifying: re-running ${saved.filePath}…\n`));
        }
        const rerun = (await app.testing.runTests({
            testFile: saved.filePath,
        })) as RepairRunResult;
        verified = rerun.success === true;
        if (!verified && options.apply === true && !options.confirm) {
            await app.testing.saveFileContent({
                filePath: file,
                content: repair.originalCode ?? testCode,
            });
            reverted = true;
        }
    }

    restore?.();
    if (options.json) {
        emit({
            repaired: true,
            applied: !reverted,
            filePath: saved.filePath,
            mode: repair.mode,
            editCount: repair.editCount,
            matchFailed: repair.matchFailed,
            ...(verified === undefined ? {} : { verified }),
            ...(reverted ? { reverted } : {}),
        });
        cliExit(verified === false ? 1 : 0);
    }

    if (verified === true) {
        console.log(chalk.green(`  ✓ Updated ${saved.filePath} — re-run passed.`));
        cliExit(0);
    }
    if (verified === false) {
        if (reverted) {
            console.log(
                chalk.red(
                    `  ✗ The fix did not pass on re-run — reverted ${saved.filePath} to its previous content.`,
                ),
            );
        } else {
            console.log(chalk.red(`  ✗ Updated ${saved.filePath}, but the re-run still fails.`));
            console.log(dim(`  Inspect with: raiken test ${saved.filePath}`));
        }
        cliExit(1);
    }
    console.log(chalk.green(`  ✓ Updated ${saved.filePath}`));
    console.log(dim(`  Re-run to verify: raiken test ${saved.filePath}`));
    cliExit(0);
}

/**
 * `raiken repair [file]` — resolve the failing spec (argument, or the single
 * broken spec on record), run it fresh, then drive the repair flow.
 */
export async function repairCommand(
    file: string | undefined,
    options: RepairCommandOptions,
): Promise<void> {
    const projectPath = process.cwd();
    const app = createProjectApplication(projectPath);

    let target = file;
    if (!target) {
        const { files } = await app.testing.listTestFiles();
        const broken = files.filter((f) => f.status === "broken");
        if (broken.length === 0) {
            if (options.json) {
                emitJson({
                    repaired: false,
                    error: "No failing spec on record. Pass a file: raiken repair <file>.",
                });
            } else {
                console.log(
                    dim(
                        "  No failing spec on record. Pass a file: raiken repair <file> " +
                            "(run `raiken test` first so failures are tracked).",
                    ),
                );
            }
            cliExit(1);
        }
        if (broken.length > 1) {
            const list = broken.map((f) => f.path).join(", ");
            exitUsage(`Multiple failing specs — pass one explicitly: ${list}`);
        }
        const firstBroken = broken[0];
        if (!firstBroken) {
            cliExit(1);
        }
        target = firstBroken.path;
    }

    // AI work is unavoidable once we commit to running the spec — fail fast
    // instead of spending seconds on a run whose failure we then can't
    // repair. Keyless providers (Ollama) skip the check. The `test --fix`
    // path enters repairFailedRun directly and re-checks there.
    const keyError = missingAiKeyMessage(projectPath);
    if (keyError) {
        if (options.json) emitJson({ repaired: false, filePath: target, error: keyError });
        else console.log(chalk.red(`  ${keyError}`));
        cliExit(CLI_EXIT.CONFIG_AUTH);
    }

    if (!options.json) {
        process.stderr.write(dim(`\n  Running ${target} to capture the failure…\n`));
    }
    const run = (await app.testing.runTests({ testFile: target })) as RepairRunResult;
    if (run.success) {
        if (options.json) {
            emitJson({
                repaired: false,
                applied: false,
                filePath: target,
                message: "Spec passes — nothing to repair.",
            });
        } else {
            console.log(chalk.green(`  ✓ ${target} passes — nothing to repair.`));
        }
        cliExit(0);
    }

    await repairFailedRun({ projectPath, file: target, run, options });
}
