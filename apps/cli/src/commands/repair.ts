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
    applyRepairSetupFixes,
    createProjectApplication,
    describeGroundingViolations,
    describeReassertedAbsence,
    describeTimeoutFocus,
    extractOrigins,
    extractProvenAbsentLocators,
    gatherRepairEvidence,
    getProvider,
    maybeCaptureMissingRepairPage,
    resolveAIConfig,
    stillAssertsAbsentLocators,
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
 * Sent on the retry after a model answers with the spec byte-for-byte
 * unchanged. Naming the non-answer is what stops the second pass from being
 * an identical no-op.
 */
const NO_CHANGE_ESCALATION = `[ESCALATION] Your previous answer returned this spec unchanged. The spec is
failing right now, so "no change" cannot be correct. Identify the first step
that cannot succeed against the captured page evidence and change that step.
If the evidence genuinely does not show the element, change the locator to the
closest element the evidence DOES show. Never respond with the file unchanged.`;

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
    const originalOnDisk = testCode;
    const earlyFailureText = [
        rawOutput,
        ...failures.map((f) => f.error?.message ?? ""),
    ].join("\n");
    const live = await maybeCaptureMissingRepairPage({
        projectPath,
        testCode,
        failureText: earlyFailureText,
        evidence,
    });
    const pageSummaries = live.pageSummaries;

    // If storageState exists but is stale, a live capture behind the login wall
    // is worthless — say so before spending LLM calls.
    try {
        const { authLivenessBlocks, probeAuthState } = await import("@raiken/core");
        const liveness = await probeAuthState({ projectPath });
        if (authLivenessBlocks(liveness) && !options.json) {
            process.stderr.write(chalk.yellow(`  ⚠ ${liveness.message}\n`));
        }
    } catch {
        /* probe is best-effort for repair */
    }

    if (!options.json) {
        process.stderr.write(dim(`\n  Repairing ${file} (${failures.length} failing test(s))…\n`));
        if (live.message) {
            process.stderr.write(dim(`  ${live.message}\n`));
        } else if (evidence.snapshots.length > 0) {
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
            pageSummaries,
        });
        if (!interpreted.error && interpreted.interpretation.trim()) {
            interpretation = interpreted.interpretation;
            if (!options.json) {
                const preview = interpretation.split("\n").slice(0, 12).join("\n");
                console.log(dim(`\n  Diagnosis\n  ${preview.split("\n").join("\n  ")}`));
            }
        }
    }

    // Deterministic setup fixes — missing storageState / absolute gotos against
    // the project's own baseURL are not AI problems.
    const failureText = [
        earlyFailureText,
        interpretation ?? "",
    ].join("\n");
    const setup = applyRepairSetupFixes(testCode, projectPath, {
        baseURL: evidence.baseURL,
        knownOrigins: new Set([...evidence.knownOrigins, ...extractOrigins(testCode)]),
        failureText,
    });
    if (setup.code !== testCode) {
        testCode = setup.code;
        if (!options.json) {
            for (const fix of setup.fixes) {
                console.log(dim(`  setup: ${fix}`));
            }
        }
        if (options.apply === true) {
            await app.testing.saveFileContent({ filePath: file, content: testCode });
        }
    }

    // One fix pass rarely lands on the first try when a spec is wrong in more
    // than one place — the re-run after attempt N surfaces the NEXT failure,
    // which is exactly the input attempt N+1 needs. Bounded so a fix that
    // isn't converging can't grind LLM calls and browser runs forever.
    const MAX_FIX_ATTEMPTS = 3;
    const unattended = options.apply === true && !options.confirm;
    // Origins the ORIGINAL spec and the knowledge DB vouch for. Deliberately
    // not widened between attempts: an origin introduced by attempt N must
    // not become "known" when linting attempt N+1.
    const knownOrigins = new Set([...evidence.knownOrigins, ...extractOrigins(originalOnDisk)]);
    const originalContent = originalOnDisk;

    let currentCode = testCode;
    let currentResults = testResults;
    let currentRaw = rawOutput;
    let previousFixed: string | undefined;
    let applied = false;
    let verified: boolean | undefined;
    let reverted = false;
    let lastRepair: Awaited<ReturnType<typeof app.testing.repairTestResults>> | undefined;
    let stopReason: string | undefined;

    const revertIfUnattended = async (): Promise<void> => {
        if (applied && unattended) {
            await app.testing.saveFileContent({ filePath: file, content: originalContent });
            reverted = true;
        }
    };

    // A timeout carries no assertion to reason about, so the model needs the
    // pending locator and the "wrong locator vs. never reached the page" split
    // spelled out — otherwise it answers with the spec unchanged.
    let timeoutFocus = describeTimeoutFocus(failureText);
    let escalated = false;
    if (timeoutFocus && !options.json) {
        console.log(dim("  Failure is a timeout — repairing with locator-focused evidence."));
    }

    // Locators this run proved match nothing. A fix that keeps them (usually
    // by qualifying them — `level`, `exact`, a longer timeout) cannot pass, so
    // catching it here costs one LLM call instead of a whole browser re-run.
    let absentLocators = extractProvenAbsentLocators(failureText);
    let absenceEscalated = false;

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        const guidance = [attempt === 1 ? interpretation : undefined, timeoutFocus]
            .filter(Boolean)
            .join("\n\n");
        const repair = await app.testing.repairTestResults({
            testResults: currentResults,
            testCode: currentCode,
            testFilePath: file,
            rawOutput: currentRaw,
            pageSummaries,
            // The diagnosis was made against the original failure; later
            // attempts carry the fresh run output instead.
            ...(guidance ? { interpretation: guidance } : {}),
        });
        lastRepair = repair;

        if (repair.error || !repair.fixedCode) {
            const message = repair.error ?? "The AI could not produce a corrected test.";
            if (attempt === 1) {
                restore?.();
                if (options.json) emit({ repaired: false, filePath: file, error: message });
                else console.log(chalk.red(`  ${message}`));
                cliExit(1);
            }
            stopReason = message;
            break;
        }

        // Re-apply deterministic setup on the AI draft (models often strip
        // storageState or reintroduce absolute gotos against the project origin).
        const normalized = applyRepairSetupFixes(repair.fixedCode, projectPath, {
            baseURL: evidence.baseURL,
            knownOrigins,
            failureText: [currentRaw, interpretation ?? ""].join("\n"),
        });
        const fixedCode = normalized.code;

        const unchangedFromCurrent = fixedCode === (repair.originalCode ?? currentCode);
        const unchangedFromPrevious =
            previousFixed !== undefined && fixedCode.trim() === previousFixed.trim();
        if (unchangedFromCurrent || unchangedFromPrevious) {
            // Returning the spec untouched is not a verdict that the spec is
            // correct — the spec just failed. It nearly always means the
            // failure text carried nothing to act on (a bare timeout). Say that
            // outright and spend one more attempt before giving up, instead of
            // reporting "no changes" and exiting 0 on a still-broken spec.
            if (unchangedFromCurrent && !escalated && attempt < MAX_FIX_ATTEMPTS) {
                escalated = true;
                timeoutFocus = [timeoutFocus, NO_CHANGE_ESCALATION].filter(Boolean).join("\n\n");
                if (!options.json) {
                    console.log(
                        dim(
                            "  The AI returned the spec unchanged — retrying with the failure spelled out.",
                        ),
                    );
                }
                continue;
            }
            stopReason = unchangedFromCurrent
                ? "the AI returned the spec unchanged — the failure evidence does not point at a fix"
                : "the AI is no longer making progress on this spec";
            break;
        }

        // A fix that still targets an element this run proved absent is not a
        // fix. Spend the remaining attempt on a corrected instruction rather
        // than on a browser run that can only fail the same way.
        const reasserted = stillAssertsAbsentLocators(fixedCode, absentLocators);
        if (reasserted.length > 0 && !absenceEscalated && attempt < MAX_FIX_ATTEMPTS) {
            absenceEscalated = true;
            timeoutFocus = [timeoutFocus, describeReassertedAbsence(reasserted)]
                .filter(Boolean)
                .join("\n\n");
            if (!options.json) {
                console.log(
                    chalk.yellow(
                        `  ✗ The fix still asserts ${reasserted.join(", ")}, which this run proved is not on the page — retrying.`,
                    ),
                );
            }
            continue;
        }

        // Lint the proposed fix against project evidence BEFORE anyone applies
        // it. A fix may only reference origins the spec or the knowledge DB
        // already knows (a new origin is a hallucinated URL, not a repair), and
        // must not introduce locators the captured pages contradict.
        const currentGrounding = validateSelectorGrounding(
            repair.originalCode ?? currentCode,
            pageSummaries,
            evidence.sourceSelectors,
        );
        const fixedGrounding = validateSelectorGrounding(
            fixedCode,
            pageSummaries,
            evidence.sourceSelectors,
        );
        const introducedContradictions = fixedGrounding.contradictions.filter(
            (violation) =>
                !currentGrounding.contradictions.some(
                    (previous) => previous.locator === violation.locator,
                ),
        );
        const newOrigins = [...extractOrigins(fixedCode)].filter(
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
            if (options.json || unattended) {
                await revertIfUnattended();
                restore?.();
                const message = `Repair rejected by grounding lint:\n${lintFindings
                    .map((finding) => `- ${finding}`)
                    .join("\n")}`;
                if (options.json) {
                    emit({
                        repaired: false,
                        applied: applied && !reverted,
                        filePath: file,
                        error: message,
                        ...(reverted ? { reverted } : {}),
                    });
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

        const diff = formatUnifiedDiff(repair.originalCode ?? currentCode, fixedCode, {
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
            const question =
                attempt === 1
                    ? `Apply this fix to ${file}?`
                    : `Attempt ${attempt}: apply this follow-up fix to ${file}?`;
            if (options.confirm) {
                apply = await options.confirm(question);
            } else if (!process.stdin.isTTY) {
                restore?.();
                exitUsage(
                    `Repair produced a fix but cannot prompt for confirmation (stdin is not interactive). Re-run with --apply to write it.`,
                );
            } else {
                const { confirm } = await import("@inquirer/prompts");
                apply = await confirm({ message: question, default: false });
            }
        }

        if (!apply) {
            if (attempt === 1) {
                restore?.();
                if (options.json) {
                    emit({
                        repaired: true,
                        applied: false,
                        filePath: file,
                        mode: repair.mode,
                        editCount: repair.editCount,
                        matchFailed: repair.matchFailed,
                        diff: formatUnifiedDiff(repair.originalCode ?? currentCode, fixedCode, {
                            plain: true,
                        }),
                    });
                } else {
                    console.log(dim("  Fix discarded — the spec was not changed."));
                }
                cliExit(0);
            }
            // A follow-up fix was declined: keep what the human already
            // approved and report the (still failing) verification honestly.
            stopReason = "the follow-up fix was declined";
            break;
        }

        await app.testing.saveFileContent({ filePath: file, content: fixedCode });
        applied = true;

        if (options.verify === false) {
            restore?.();
            if (options.json) {
                emit({
                    repaired: true,
                    applied: true,
                    filePath: file,
                    mode: repair.mode,
                    editCount: repair.editCount,
                    matchFailed: repair.matchFailed,
                });
                cliExit(0);
            }
            console.log(chalk.green(`  ✓ Updated ${file}`));
            console.log(dim(`  Re-run to verify: raiken test ${file}`));
            cliExit(0);
        }

        if (!options.json) {
            process.stderr.write(
                dim(
                    `\n  Verifying (attempt ${attempt}/${MAX_FIX_ATTEMPTS}): re-running ${file}…\n`,
                ),
            );
        }
        const rerun = (await app.testing.runTests({ testFile: file })) as RepairRunResult;
        if (rerun.success === true) {
            verified = true;
            restore?.();
            if (options.json) {
                emit({
                    repaired: true,
                    applied: true,
                    filePath: file,
                    mode: repair.mode,
                    editCount: repair.editCount,
                    matchFailed: repair.matchFailed,
                    verified: true,
                    attempts: attempt,
                });
                cliExit(0);
            }
            console.log(
                chalk.green(
                    `  ✓ Updated ${file} — re-run passed${attempt > 1 ? ` (attempt ${attempt})` : ""}.`,
                ),
            );
            cliExit(0);
        }

        verified = false;
        const rerunFailures = (rerun.parsedRun?.tests ?? []).filter((t) => t.status === "failed");
        if (rerunFailures.length === 0) {
            // The run failed without per-test results (suite-level breakage) —
            // there is nothing new to feed a retry.
            stopReason = "the re-run failed before producing per-test results";
            break;
        }
        if (attempt < MAX_FIX_ATTEMPTS && !options.json) {
            process.stderr.write(
                dim(`  Attempt ${attempt} did not pass — retrying with the new failure.\n`),
            );
        }
        previousFixed = fixedCode;
        currentCode = fixedCode;
        currentResults = rerunFailures.map((t) => ({
            name: t.name ?? "unknown",
            suite: t.suite ?? file,
            status: "failed" as const,
            ...(typeof t.duration === "number" ? { duration: t.duration } : {}),
            ...(t.error ? { error: t.error } : {}),
            ...(t.attachments ? { attachments: t.attachments } : {}),
        }));
        currentRaw = composeRawOutput(rerun);
        absentLocators = extractProvenAbsentLocators(currentRaw);
    }

    // All attempts exhausted (or the loop stopped early) without a green run.
    await revertIfUnattended();
    restore?.();
    if (options.json) {
        emit({
            repaired: applied,
            applied: applied && !reverted,
            filePath: file,
            ...(lastRepair ? { mode: lastRepair.mode, editCount: lastRepair.editCount } : {}),
            verified: false,
            ...(reverted ? { reverted } : {}),
            ...(stopReason ? { stopReason } : {}),
        });
        cliExit(1);
    }
    if (reverted) {
        console.log(
            chalk.red(
                `  ✗ No fix passed within ${MAX_FIX_ATTEMPTS} attempt(s) — reverted ${file} to its original content.`,
            ),
        );
    } else if (applied) {
        console.log(chalk.red(`  ✗ Updated ${file}, but the re-run still fails.`));
        console.log(dim(`  Inspect with: raiken test ${file}`));
    } else {
        console.log(chalk.red(`  ✗ Repair stopped: ${stopReason ?? "no usable fix"}.`));
    }
    if (stopReason && applied) {
        console.log(dim(`  Stopped because ${stopReason}.`));
    }
    if (absentLocators.length > 0) {
        console.log(
            dim(
                `  The spec expects ${absentLocators.join(", ")}, which never appeared. Repair rewrites specs, ` +
                    "it cannot make missing UI exist — either the scenario is wrong (re-draft it with " +
                    "`raiken cover` after `raiken auth` / `raiken discover` so it sees the real pages), " +
                    "or the app is.",
            ),
        );
    }
    cliExit(1);
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
