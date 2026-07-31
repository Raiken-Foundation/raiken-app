import { existsSync } from "node:fs";
import * as path from "node:path";
import {
    BrowserSession,
    createProjectApplication,
    getProvider,
    resolveAIConfig,
    runOrchestrator,
} from "@raiken/core";
import { splitTestSavePath } from "@raiken/shared";
import chalk from "chalk";
import { dim, renderToolCall, routeDiagnosticsToStderr, splitHITL } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";
import { CLI_EXIT, type CliExitCode, safeCliErrorMessage } from "../errors";
import { createEventStream, nowTs } from "../repl/events";
import { cliExit } from "../repl/exit";

export interface OneShotOptions {
    /** The request. When empty, the prompt is read from piped stdin. */
    prompt: string;
    /** Emit a single machine-readable JSON object to stdout instead of streaming. */
    json: boolean;
    /**
     * Emit NDJSON events on stdout as the run progresses (start/tool/progress/
     * text/hitl/done). Mutually exclusive with human streaming; preferred over
     * `--json` for editor integrations that want live updates.
     */
    streamJson: boolean;
    /** Auto-save a generated test to disk (default true). */
    save: boolean;
    /** Run the saved test after generation and reflect pass/fail in the exit code. */
    run: boolean;
    /** Show the browser (default headless for scriptability). */
    headed: boolean;
    /** Abort the run after this many milliseconds. */
    timeoutMs?: number;
}

interface RunSummary {
    success: boolean;
    passed: number;
    failed: number;
    skipped: number;
}

function hitlWorkflowId(hitl: Record<string, unknown> | null): string | undefined {
    const context =
        hitl?.context && typeof hitl.context === "object"
            ? (hitl.context as Record<string, unknown>)
            : {};
    return typeof context.workflowId === "string" ? context.workflowId : undefined;
}

function summarizeWorkflowRun(run: {
    success: boolean;
    results?: Array<{ status: string }>;
}): RunSummary {
    const results = run.results ?? [];
    return {
        success: run.success,
        passed: results.filter((result) => result.status === "passed").length,
        failed: results.filter(
            (result) => result.status !== "passed" && result.status !== "skipped",
        ).length,
        skipped: results.filter((result) => result.status === "skipped").length,
    };
}

export interface OneShotOutcomeInput {
    /**
     * True when the agent actually produced test code this run — either an
     * approval payload carrying a draft, or its own `saveFile` tool call. A
     * prompt that only asked a question produces none, and must not be held
     * to artifact expectations.
     */
    producedTest: boolean;
    /** False only when `--no-save` was passed. */
    saveRequested: boolean;
    /** Path of an artifact CONFIRMED to exist on disk, or null. */
    savedTest: string | null;
    saveError: string | null;
    /** True when `--run` was passed. */
    runRequested: boolean;
    runSummary: RunSummary | null;
}

export interface OneShotOutcome {
    ok: boolean;
    exitCode: CliExitCode;
    /** Why the run is not ok. Absent when it is. */
    reason?: string;
}

/**
 * The agent responding without throwing does NOT mean the run did what was
 * asked. `ok` (and the exit code) must reflect the whole request, because a
 * machine consumer checking only `ok`, or a script checking only the exit
 * code, has nothing else to go on.
 *
 * Four distinct ways a run can finish without doing what was asked, all
 * observed in practice:
 *
 *   1. the save threw;
 *   2. a test was generated and a save was wanted, but no file exists —
 *      the case where a repair emitted tool tags, wrote nothing, ran
 *      nothing, and still reported success;
 *   3. `--run` was asked for and never happened (nothing to run);
 *   4. the run happened and its tests failed.
 *
 * Extracted as a pure function so the contract is unit-testable without
 * driving the full orchestrator/browser stack.
 */
export function computeOneShotOutcome(input: OneShotOutcomeInput): OneShotOutcome {
    const notOk = (reason: string): OneShotOutcome => ({
        ok: false,
        exitCode: CLI_EXIT.RUNTIME_FAILURE,
        reason,
    });

    if (input.saveError) return notOk(input.saveError);
    if (input.producedTest && input.saveRequested && !input.savedTest) {
        return notOk(
            "A test was generated but no file exists on disk for it. Nothing was saved, so nothing was verified.",
        );
    }
    if (input.runRequested && input.producedTest && !input.runSummary) {
        return notOk("--run was requested but the generated test was never executed.");
    }
    if (input.runSummary && !input.runSummary.success) {
        return notOk(
            `The test run failed (${input.runSummary.passed} passed, ${input.runSummary.failed} failed).`,
        );
    }
    return { ok: true, exitCode: CLI_EXIT.SUCCESS };
}

/**
 * Read the prompt from piped stdin. Only ever called when NO prompt argument was
 * given, because reading stdin blocks until EOF — and a non-TTY stdin that is an
 * inherited/open pipe (common under CI runners, editor integrations, or a shell
 * that leaves the descriptor open) may never send EOF, hanging the process
 * forever. When a prompt argument exists we skip stdin entirely and return "".
 */
async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Non-interactive one-shot agent run: `raiken -p "test the login flow"`.
 *
 * Designed for scripting, CI, editor integrations and Unix piping:
 *   - stdout carries ONLY the agent's answer (human), a single JSON object
 *     (`--json`), or NDJSON events (`--stream-json`).
 *   - all engine diagnostics/progress/tool-calls go to stderr (unless
 *     `--stream-json`, where tools/progress are structured events on stdout).
 *   - the prompt comes from the argument, or from piped stdin when no arg given.
 *   - generated tests are auto-saved (opt-out via --no-save) and optionally run.
 *   - the exit code reflects success (and test pass/fail when --run is used).
 */
export async function runOneShotCommand(options: OneShotOptions): Promise<void> {
    const projectPath = process.cwd();
    process.env.RAIKEN_HEADLESS = options.headed ? "0" : "1";

    const streamJson = options.streamJson === true;
    const json = options.json === true && !streamJson;
    const events = createEventStream(streamJson);

    // Keep stdout pristine for machine modes: route engine console.* to stderr.
    const restoreConsole = routeDiagnosticsToStderr();

    const fail = (error: unknown, code: CliExitCode = CLI_EXIT.RUNTIME_FAILURE): never => {
        const message = safeCliErrorMessage(error);
        if (streamJson) {
            events.emit({ type: "done", ok: false, error: message, ts: nowTs() });
        }
        restoreConsole();
        if (json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
        } else if (!streamJson) {
            process.stderr.write(chalk.red(`\n  ✗ ${message}\n`));
        }
        cliExit(code);
    };

    let prompt = (options.prompt || "").trim();
    if (!prompt) prompt = (await readStdin()).trim();
    if (!prompt) {
        return void fail(
            'No prompt provided. Use: raiken -p "test the login flow"  (or pipe input on stdin).',
            CLI_EXIT.USAGE,
        );
    }

    // Fail fast when the run cannot possibly work: without an API key the
    // orchestrator streams an "API Key Required" message and returns
    // normally, which used to make one-shot exit 0 with `ok: true` — a CI
    // pipeline would green-light a run where nothing happened. Config/auth
    // problems are exit 3 by contract.
    {
        const resolved = resolveAIConfig(projectPath);
        const provider = getProvider(resolved.provider);
        if (provider.envVars.length > 0 && !resolved.apiKey) {
            return void fail(
                `No API key configured for ${provider.label}. Run \`raiken config\` to save one, ` +
                    `or set ${provider.envVars[0]} in your environment.`,
                CLI_EXIT.CONFIG_AUTH,
            );
        }
    }

    const bootResult = await bootstrapProject(projectPath, {
        watch: false,
        verbose: !json && !streamJson,
    });
    // Code understanding is best-effort here — a browser-only task can still
    // succeed without it — but the caller should know context was degraded.
    if (!bootResult.ok && streamJson) {
        events.emit({
            type: "progress",
            label: "Code understanding unavailable",
            detail: "Search, impact analysis, and context lookups will be empty for this run.",
            ts: nowTs(),
        });
    }

    const app = createProjectApplication(projectPath);

    const abort = new AbortController();
    const timer = options.timeoutMs ? setTimeout(() => abort.abort(), options.timeoutMs) : null;
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);

    let assistant = "";
    let pendingHITL: Record<string, unknown> | null = null;
    let agentSavedPath: string | null = null;
    const toolCalls: string[] = [];

    events.emit({ type: "start", prompt, ts: nowTs() });

    try {
        const stream = runOrchestrator({
            userPrompt: prompt,
            projectPath,
            conversationHistory: [],
            signal: abort.signal,
            onToolCall: (name, args) => {
                toolCalls.push(name);
                if (name === "saveFile") {
                    const a = (args ?? {}) as { filePath?: unknown; path?: unknown };
                    const p = typeof a.filePath === "string" ? a.filePath : a.path;
                    if (typeof p === "string" && /\.(spec|test)\.[tj]sx?$/.test(p)) {
                        agentSavedPath = p;
                    }
                }
                if (streamJson) {
                    events.emit({ type: "tool", name, args, ts: nowTs() });
                } else if (!json) {
                    renderToolCall(name, args);
                }
            },
        });
        for await (const chunk of stream) {
            const { text, hitl } = splitHITL(chunk, {
                onProgress: (label, detail) => {
                    if (streamJson) {
                        events.emit({ type: "progress", label, detail, ts: nowTs() });
                    }
                },
                suppressProgressPrint: streamJson || json,
            });
            if (hitl && (hitl.kind === "save_approval" || hitl.kind === "run_approval")) {
                pendingHITL = hitl;
                if (streamJson) {
                    events.emit({
                        type: "hitl",
                        kind: String(hitl.kind),
                        payload: {
                            suggestedPath: hitl.suggestedPath,
                            testFile: hitl.testFile,
                            // Omit full test code from the event stream by default —
                            // editors can request it via the final done payload.
                            hasTestCode: typeof hitl.testCode === "string",
                        },
                        ts: nowTs(),
                    });
                }
            }
            if (text) {
                assistant += text;
                if (streamJson) {
                    events.emit({ type: "text", text, ts: nowTs() });
                } else if (!json) {
                    process.stdout.write(text);
                }
            }
        }
        if (!json && !streamJson && assistant && !assistant.endsWith("\n")) {
            process.stdout.write("\n");
        }
    } catch (err) {
        const workflowId = hitlWorkflowId(pendingHITL);
        if (
            workflowId &&
            (pendingHITL?.kind === "save_approval" || pendingHITL?.kind === "run_approval")
        ) {
            await app.hitl
                .continue({
                    workflowId,
                    action: pendingHITL.kind === "save_approval" ? "save" : "run",
                    decision: "reject",
                })
                .catch(() => undefined);
        }
        if (abort.signal.aborted) return void fail("Run aborted.", CLI_EXIT.CANCELLED);
        return void fail(err);
    } finally {
        if (timer) clearTimeout(timer);
        process.off("SIGINT", onSigint);
    }

    // Tracks WHY a requested save/run didn't succeed, independent of the
    // human-readable stderr messages below (which are suppressed in
    // json/streamJson modes). Both the final `ok` flag and the exit code must
    // reflect this — a machine consumer checking only `ok` must never see
    // `true` after a save or run it explicitly asked for actually failed.
    let saveError: string | null = null;

    const draftFromApproval =
        pendingHITL && typeof pendingHITL.testCode === "string" ? pendingHITL.testCode : "";
    const workflowId = hitlWorkflowId(pendingHITL);
    const pendingKind =
        pendingHITL?.kind === "save_approval" || pendingHITL?.kind === "run_approval"
            ? pendingHITL.kind
            : undefined;
    // Whether the agent produced a test at all — the only signal that makes
    // "a saved file must exist" a fair expectation. Asking a question, or
    // exploring a site, legitimately leaves no artifact behind.
    const producedTest = Boolean(draftFromApproval) || agentSavedPath !== null;

    let savedTest: string | null = null;
    let workflowStatusAfterSave: string | undefined;
    if (pendingKind === "save_approval" && pendingHITL && options.save) {
        const suggestedPath =
            typeof pendingHITL.suggestedPath === "string" ? pendingHITL.suggestedPath : "";
        if (draftFromApproval && suggestedPath) {
            try {
                if (workflowId) {
                    const result = await app.hitl.continue({
                        workflowId,
                        action: "save",
                        decision: "approve",
                        filePath: suggestedPath,
                        // Only dedupe to `name-2.spec.ts` for a path the agent
                        // invented. When it deliberately targeted an existing
                        // spec, redirecting the write is the bug, not the guard.
                        avoidOverwrite: pendingHITL.overwriteTarget !== true,
                    });
                    savedTest = result.savedPath ?? null;
                    workflowStatusAfterSave = result.workflow.status;
                    if (!savedTest) {
                        saveError =
                            result.workflow.statusMessage ??
                            "The durable save workflow did not produce a test artifact.";
                    }
                } else {
                    const { fileName, testDir } = splitTestSavePath(suggestedPath);
                    const result = await app.testing.saveGeneratedTest({
                        fileName,
                        content: draftFromApproval,
                        testDir,
                        avoidOverwrite: pendingHITL.overwriteTarget !== true,
                    });
                    savedTest = result.filePath;
                }
                if (savedTest && !json && !streamJson) {
                    process.stderr.write(chalk.green(`\n  ✓ Saved ${savedTest}\n`));
                }
            } catch (err) {
                if (workflowId) {
                    await app.hitl
                        .continue({
                            workflowId,
                            action: "save",
                            decision: "reject",
                        })
                        .catch(() => undefined);
                }
                saveError = safeCliErrorMessage(err);
                if (!json && !streamJson) {
                    process.stderr.write(chalk.red(`\n  ✗ Save failed: ${saveError}\n`));
                }
            }
        } else {
            saveError =
                "Agent proposed a test but the approval payload was missing test code or a save path.";
        }
    } else if (pendingKind === "save_approval" && workflowId && !options.save) {
        await app.hitl.continue({
            workflowId,
            action: "save",
            decision: "reject",
        });
        workflowStatusAfterSave = "cancelled";
    } else if (pendingKind === "run_approval" && pendingHITL) {
        const testFile = typeof pendingHITL.testFile === "string" ? pendingHITL.testFile : "";
        if (testFile) savedTest = testFile;
    }

    if (!savedTest && agentSavedPath) savedTest = agentSavedPath;

    // A recorded path proves only that a save was ATTEMPTED: a `saveFile`
    // call that hit the HITL gate returns `saved: false` and writes nothing,
    // and a rejected draft never gets that far. `savedTest` is reported to
    // the caller as an artifact it can open and run, so confirm it exists
    // before claiming it — and drop it if it doesn't, so a run isn't
    // attempted against a file that was never written.
    if (savedTest && options.save && !existsSync(path.resolve(projectPath, savedTest))) {
        saveError = `Expected a saved test at ${savedTest} but no file exists there.`;
        savedTest = null;
        if (!json && !streamJson) {
            process.stderr.write(chalk.red(`\n  ✗ ${saveError}\n`));
        }
    }

    let runSummary: RunSummary | null = null;
    if (options.run && savedTest) {
        if (!json && !streamJson) process.stderr.write(dim(`  Running ${savedTest}...\n`));
        try {
            const shouldContinueWorkflow =
                workflowId &&
                (pendingKind === "run_approval" ||
                    workflowStatusAfterSave === "await_run_approval");
            if (shouldContinueWorkflow) {
                const result = await app.hitl.continue({
                    workflowId,
                    action: "run",
                    decision: "approve",
                });
                runSummary = result.run
                    ? summarizeWorkflowRun(result.run)
                    : { success: false, passed: 0, failed: 0, skipped: 0 };
            } else {
                const result = (await app.testing.runTests({ testFile: savedTest })) as {
                    success: boolean;
                    parsedRun?: { tests?: Array<{ status?: string }> } | null;
                };
                // Count from the parsed run (same vocabulary as `raiken test`
                // and `raiken report`), not the raw Playwright stats block —
                // that block misses reporter-level failures like compile or
                // webServer errors and under-reports failures as 0/0/0.
                const tests = result.parsedRun?.tests ?? [];
                runSummary = {
                    success: result.success,
                    passed: tests.filter((t) => t.status === "passed").length,
                    failed: tests.filter((t) => t.status === "failed").length,
                    skipped: tests.filter((t) => t.status === "skipped").length,
                };
            }
            if (!json && !streamJson) {
                const badge = runSummary.success ? chalk.green("✓ passed") : chalk.red("✗ failed");
                process.stderr.write(
                    `  ${badge}${dim(` (${runSummary.passed} passed, ${runSummary.failed} failed)`)}\n`,
                );
            }
        } catch (err) {
            if (
                workflowId &&
                (pendingKind === "run_approval" || workflowStatusAfterSave === "await_run_approval")
            ) {
                await app.hitl
                    .continue({
                        workflowId,
                        action: "run",
                        decision: "reject",
                    })
                    .catch(() => undefined);
            }
            if (!json && !streamJson) {
                process.stderr.write(chalk.red(`  ✗ Run failed: ${safeCliErrorMessage(err)}\n`));
            }
            runSummary = { success: false, passed: 0, failed: 0, skipped: 0 };
        }
    } else if (
        !options.run &&
        workflowId &&
        (pendingKind === "run_approval" || workflowStatusAfterSave === "await_run_approval")
    ) {
        await app.hitl.continue({
            workflowId,
            action: "run",
            decision: "reject",
        });
    }

    try {
        await BrowserSession.getInstance(projectPath).close();
    } catch {
        /* already closed */
    }

    const { ok, exitCode, reason } = computeOneShotOutcome({
        producedTest,
        saveRequested: options.save,
        savedTest,
        saveError,
        runRequested: options.run,
        runSummary,
    });

    if (streamJson) {
        events.emit({
            type: "done",
            ok,
            response: assistant.trim(),
            savedTest,
            saveError,
            reason,
            run: runSummary,
            ts: nowTs(),
        });
        restoreConsole();
    } else {
        restoreConsole();
        if (json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ok,
                        prompt,
                        response: assistant.trim(),
                        toolCalls,
                        savedTest,
                        saveError,
                        reason,
                        run: runSummary,
                    },
                    null,
                    2,
                )}\n`,
            );
        } else if (!ok && reason && reason !== saveError) {
            process.stderr.write(chalk.red(`\n  ✗ ${reason}\n`));
        }
    }

    cliExit(exitCode);
}
