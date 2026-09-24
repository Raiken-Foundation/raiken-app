import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { CLI_EXIT, type CliExitCode, mapErrorToCliExitCode, safeCliErrorMessage } from "../errors";
import { createEventStream, nowTs } from "../cli/events";
import { cliExit } from "../cli/exit";

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
    /**
     * When a `--run` fails, ask the AI to diagnose the failure (app bug vs
     * test bug) and include the verdict in the output (default true).
     */
    diagnose?: boolean;
    /** Show the browser (default headless for scriptability). */
    headed: boolean;
    /** Abort the run after this many milliseconds. */
    timeoutMs?: number;
    /**
     * Skip the discovery gate so `-p` can draft without site knowledge
     * (intentional scaffolds / offline use).
     */
    allowUngrounded?: boolean;
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
    /**
     * Set when the saved spec sits outside what the project's Playwright
     * `testMatch` collects — the run then reports "No tests found" and the
     * spec looks empty, when the real problem is the config.
     */
    uncollectedSpecReason?: string | null;
    /**
     * True when the agent ended the run by asking the user a question
     * (`awaitUser`). One-shot has no one to ask, so the request was abandoned
     * mid-flight no matter how clean the stream looked.
     */
    awaitedUserInput?: boolean;
    /** The question the agent paused on, when it paused. */
    awaitUserMessage?: string | null;
    /**
     * Cover-equivalent honesty gates on the saved draft. When set, oneshot
     * refuses to report success the same way `raiken cover` does.
     */
    needsReview?: boolean;
    blocked?: boolean;
    reviewReasons?: string[];
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
    // A pause is a dead end here: nothing can answer it, so the run stops
    // wherever it stood. Reporting success would tell a CI pipeline the flow
    // was covered when the agent never got past the question.
    if (input.awaitedUserInput) {
        const question = input.awaitUserMessage?.trim();
        return {
            ok: false,
            exitCode: CLI_EXIT.CONFIG_AUTH,
            reason:
                "The agent paused to ask for input, which one-shot mode cannot answer" +
                `${question ? `: "${question}"` : "."}` +
                " Put the value in the prompt, configure it under `auth.credentials` in " +
                "raiken.config.json, or run `raiken auth` to save a session.",
        };
    }
    if (input.producedTest && input.saveRequested && !input.savedTest) {
        return notOk(
            "A test was generated but no file exists on disk for it. Nothing was saved, so nothing was verified.",
        );
    }
    if (input.runRequested && !input.runSummary) {
        return notOk("--run was requested but the generated test was never executed.");
    }
    if (input.runSummary && !input.runSummary.success) {
        // A run that collected nothing is a config problem, not a test result.
        // Leading with the counts sends people debugging a spec that never ran.
        if (input.uncollectedSpecReason) return notOk(input.uncollectedSpecReason);
        return notOk(
            `The test run failed (${input.runSummary.passed} passed, ${input.runSummary.failed} failed).`,
        );
    }
    if (input.producedTest && (input.blocked || input.needsReview)) {
        const reasons = (input.reviewReasons ?? []).filter(Boolean);
        const head = input.blocked
            ? "Generated draft is blocked and cannot run as written"
            : "Generated draft needs review before it can be trusted";
        return notOk(reasons.length > 0 ? `${head}: ${reasons.join("; ")}` : head);
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
    // Lets core skip interactive-only chatter (the pause log) in this mode.
    process.env.RAIKEN_ONESHOT = "1";

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

    // Same cold-start gate as cover: refuse to invent without site knowledge,
    // or auto-discover when baseURL/webServer.url is known.
    try {
        const { ensureSiteKnowledge, looksLikeAuthScenario } = await import("@raiken/core");
        const knowledge = await ensureSiteKnowledge({
            projectPath,
            allowUngrounded: options.allowUngrounded === true,
            needsAuthenticatedKnowledge: looksLikeAuthScenario(prompt),
            onProgress: (message) => {
                if (streamJson) {
                    events.emit({
                        type: "progress",
                        label: "site knowledge",
                        detail: message,
                        ts: nowTs(),
                    });
                } else if (!json) {
                    process.stderr.write(dim(`  ${message}\n`));
                }
            },
        });
        if (knowledge.status === "ready" && knowledge.discovered && !json && !streamJson) {
            process.stderr.write(
                dim(`  Site knowledge ready from ${knowledge.seedUrl ?? "seed URL"}.\n`),
            );
        }
        if (!options.allowUngrounded) {
            const { authLivenessBlocks, probeAuthState } = await import("@raiken/core");
            const liveness = await probeAuthState({ projectPath, headed: options.headed });
            if (authLivenessBlocks(liveness)) {
                return void fail(liveness.message, CLI_EXIT.CONFIG_AUTH);
            }
            if (
                (liveness.status === "live" || liveness.status === "stale") &&
                !json &&
                !streamJson &&
                !liveness.fromCache
            ) {
                process.stderr.write(dim(`  ${liveness.message}\n`));
            }
        }
    } catch (err) {
        return void fail(err, CLI_EXIT.USAGE);
    }

    const abort = new AbortController();
    const timer = options.timeoutMs ? setTimeout(() => abort.abort(), options.timeoutMs) : null;
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);

    let assistant = "";
    let pendingHITL: Record<string, unknown> | null = null;
    let agentSavedPath: string | null = null;
    let awaitUserMessage: string | null = null;
    const toolCalls: string[] = [];

    events.emit({ type: "start", prompt, ts: nowTs() });

    try {
        const stream = runOrchestrator({
            userPrompt: prompt,
            projectPath,
            conversationHistory: [],
            signal: abort.signal,
            // `--no-save` is a promise about the filesystem, so it has to reach
            // the tool layer. Without this, a project with `autoSaveTests: true`
            // auto-approves the agent's own `saveFile` call and writes anyway —
            // the CLI flag only ever governed the approval-gated path.
            ...(options.save ? {} : { autonomyOverride: { autoSaveTests: false } }),
            onToolCall: (name, args) => {
                toolCalls.push(name);
                if (name === "awaitUser") {
                    const a = (args ?? {}) as { message?: unknown };
                    awaitUserMessage = typeof a.message === "string" ? a.message : "";
                }
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
                    // The engine's "Waiting for approval to save/run X." pause
                    // line describes a pause this command immediately resolves
                    // itself (auto-approval below) — printing it reads as the
                    // agent being stuck when it isn't.
                    const willAutoApprove = options.save || options.run;
                    const printable = willAutoApprove
                        ? text.replace(/^\s*Waiting for approval to (save|run) [^\n]*$/gm, "")
                        : text;
                    if (printable) process.stdout.write(printable);
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
        return void fail(err, mapErrorToCliExitCode(err));
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

    // Only the FIRST generation pass streams its tokens, so when the engine
    // regenerates (an ungrounded locator, an inverted assertion) the draft the
    // user just watched scroll past is not the one that gets saved and run.
    // Reprint the real one rather than leave them reading a discarded draft.
    const strip = (code: string): string => code.replace(/```[a-z]*|\s+/gi, "");
    const streamedSupersededDraft =
        Boolean(draftFromApproval) && !strip(assistant).includes(strip(draftFromApproval));
    if (streamedSupersededDraft && !json && !streamJson) {
        process.stderr.write(
            chalk.yellow(
                "\n  The draft above was regenerated before saving — the final test is below.\n",
            ),
        );
        process.stdout.write(`\n${draftFromApproval}\n`);
    }

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

    // Under `--no-save` the agent's own `saveFile` call is gated, so its path
    // names a file that was deliberately never written. Claiming it here would
    // send `--run` at a nonexistent spec ("No tests found").
    if (!savedTest && agentSavedPath && options.save) savedTest = agentSavedPath;

    // `--no-save --run` still has something to execute: the draft itself. Run
    // it from a scratch spec the runner cleans up, so the request is honoured
    // (preview + verdict) without leaving an artifact behind.
    const scratchContent = !options.save && !savedTest ? draftFromApproval : "";
    const scratchName =
        (typeof pendingHITL?.suggestedPath === "string" ? pendingHITL.suggestedPath : "") ||
        agentSavedPath ||
        "raiken-oneshot";

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

    // Writing a spec the project's Playwright config will never collect is a
    // silent dead end: the file is on disk, the run reports "No tests found",
    // and the diagnosis blames the (perfectly fine) spec.
    let uncollectedSpecReason: string | null = null;
    if (savedTest) {
        try {
            const { assessPlaywrightFit } = await import("@raiken/core");
            const fit = await assessPlaywrightFit(
                projectPath,
                path.resolve(projectPath, savedTest),
            );
            if (!fit.collectedByConfig && fit.reason) {
                uncollectedSpecReason = `Saved ${savedTest}, but ${fit.reason}`;
                if (!json && !streamJson) {
                    process.stderr.write(chalk.yellow(`\n  ⚠ ${uncollectedSpecReason}\n`));
                }
            }
        } catch {
            // Config introspection is best-effort; never block the run on it.
        }
    }

    // Hold the saved (or scratch) draft to cover's honesty gates so `-p` and
    // `cover` share one contract for "this artifact is trustworthy".
    let draftNeedsReview = false;
    let draftBlocked = false;
    let draftReviewReasons: string[] = [];
    const draftBodyForAssess =
        savedTest && options.save
            ? await readFile(path.resolve(projectPath, savedTest), "utf-8").catch(() => "")
            : scratchContent || draftFromApproval || "";
    const draftPathForAssess = savedTest
        ? path.resolve(projectPath, savedTest)
        : path.resolve(projectPath, "e2e", "raiken-oneshot.spec.ts");
    if (producedTest && draftBodyForAssess.trim()) {
        try {
            const { assessGeneratedDraft, gatherCoverEvidence } = await import("@raiken/core");
            const evidence = await gatherCoverEvidence(projectPath, prompt);
            const assessed = await assessGeneratedDraft({
                body: draftBodyForAssess,
                projectPath,
                outputPath: draftPathForAssess,
                evidence,
                description: prompt,
                ...(uncollectedSpecReason ? { extraReviewReasons: [uncollectedSpecReason] } : {}),
            });
            draftNeedsReview = assessed.needsReview;
            draftBlocked = assessed.blocked;
            draftReviewReasons = assessed.reviewReasons;
            if ((draftNeedsReview || draftBlocked) && !json && !streamJson) {
                process.stderr.write(
                    chalk.yellow(
                        draftBlocked
                            ? "\n  ✗ Draft is blocked and cannot run as written\n"
                            : "\n  ⚠ Draft needs review before it can be trusted\n",
                    ),
                );
                for (const reason of draftReviewReasons) {
                    process.stderr.write(chalk.yellow(`     - ${reason}\n`));
                }
            }
        } catch {
            // Assessment is best-effort relative to the run; never mask a save.
        }
    }

    let runSummary: RunSummary | null = null;
    let failedTestsForDiagnosis: Array<{
        name?: string;
        suite?: string;
        status?: string;
        duration?: number;
        error?: {
            message?: string;
            snippet?: string;
            location?: { file: string; line: number; column: number };
        };
    }> = [];
    if (options.run && (savedTest || scratchContent)) {
        if (!json && !streamJson) {
            process.stderr.write(
                dim(`  Running ${savedTest ?? "the draft (scratch run, nothing saved)"}...\n`),
            );
        }
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
                const result = (await app.testing.runTests(
                    savedTest
                        ? { testFile: savedTest }
                        : { testFile: `scratch:${scratchName}`, inlineContent: scratchContent },
                )) as {
                    success: boolean;
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
                        }>;
                    } | null;
                };
                failedTestsForDiagnosis = (result.parsedRun?.tests ?? []).filter(
                    (t) => t.status === "failed",
                );
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

    // A failed --run without an explanation leaves the caller staring at a
    // pass/fail count. The interpreter can usually tell whether the TEST or
    // the APPLICATION is at fault — that verdict is the difference between
    // "regenerate the test" and "file a bug", so surface it here.
    let diagnosis: string | null = null;
    const diagnosisTarget = savedTest ?? (scratchContent ? scratchName : null);
    if (
        options.diagnose !== false &&
        runSummary &&
        !runSummary.success &&
        diagnosisTarget &&
        failedTestsForDiagnosis.length > 0
    ) {
        try {
            if (!json && !streamJson) process.stderr.write(dim("  Diagnosing the failure…\n"));
            // A scratch run leaves nothing on disk, so diagnose the draft that
            // ran rather than reading back a file that was never written —
            // otherwise the interpreter sees an empty spec and blames that.
            const specCode = savedTest
                ? await readFile(path.resolve(projectPath, savedTest), "utf-8").catch(() => "")
                : scratchContent;
            const { gatherRepairEvidence, maybeCaptureMissingRepairPage } = await import(
                "@raiken/core"
            );
            const failureText = failedTestsForDiagnosis
                .map((t) => t.error?.message ?? "")
                .join("\n");
            const evidence = await gatherRepairEvidence(
                projectPath,
                `${diagnosisTarget}\n${specCode}\n${failureText}`,
            );
            const live = await maybeCaptureMissingRepairPage({
                projectPath,
                testCode: specCode,
                failureText,
                evidence,
                headed: options.headed,
            });
            if (live.message && !json && !streamJson) {
                process.stderr.write(dim(`  ${live.message}\n`));
            }
            const interpreted = await app.testing.interpretTestResults({
                testResults: failedTestsForDiagnosis.map((t) => ({
                    name: t.name ?? "unknown",
                    suite: t.suite ?? diagnosisTarget,
                    status: "failed" as const,
                    ...(typeof t.duration === "number" ? { duration: t.duration } : {}),
                    ...(t.error ? { error: t.error } : {}),
                })),
                testCode: specCode,
                testFilePath: diagnosisTarget,
                pageSummaries: live.pageSummaries,
            });
            if (!interpreted.error && interpreted.interpretation.trim()) {
                diagnosis = interpreted.interpretation.trim();
                if (streamJson) {
                    events.emit({
                        type: "progress",
                        label: "diagnosis",
                        detail: diagnosis,
                        ts: nowTs(),
                    });
                } else if (!json) {
                    const preview = diagnosis.split("\n").slice(0, 14).join("\n");
                    process.stderr.write(
                        dim(`\n  Diagnosis\n  ${preview.split("\n").join("\n  ")}\n`),
                    );
                }
            }
        } catch {
            // Diagnosis is best-effort; the run result stands on its own.
        }
    }

    const { ok, exitCode, reason } = computeOneShotOutcome({
        producedTest,
        saveRequested: options.save,
        savedTest,
        saveError,
        runRequested: options.run,
        runSummary,
        awaitedUserInput: awaitUserMessage !== null,
        awaitUserMessage,
        uncollectedSpecReason,
        needsReview: draftNeedsReview,
        blocked: draftBlocked,
        reviewReasons: draftReviewReasons,
    });

    if (streamJson) {
        events.emit({
            type: "done",
            ok,
            response: assistant.trim(),
            ...(streamedSupersededDraft ? { finalDraft: draftFromApproval } : {}),
            savedTest,
            saveError,
            reason,
            needsReview: draftNeedsReview,
            blocked: draftBlocked,
            reviewReasons: draftReviewReasons,
            run: runSummary,
            diagnosis,
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
                        // The streamed response can be a draft the engine then
                        // regenerated; this is the code that was actually saved
                        // and run.
                        ...(streamedSupersededDraft ? { finalDraft: draftFromApproval } : {}),
                        toolCalls,
                        savedTest,
                        saveError,
                        reason,
                        needsReview: draftNeedsReview,
                        blocked: draftBlocked,
                        reviewReasons: draftReviewReasons,
                        run: runSummary,
                        diagnosis,
                    },
                    null,
                    2,
                )}\n`,
            );
        } else if (!ok && reason && reason !== saveError) {
            process.stderr.write(chalk.red(`\n  ✗ ${reason}\n`));
        }
    }

    // One-shot runs are real agent sessions — persist them like the REPL does
    // (unless --no-save) so `raiken sessions`/`raiken resume` can reach them.
    // Best-effort: a persistence failure never changes the run's exit code.
    if (options.save) {
        try {
            const { saveSession } = await import("../cli/sessions");
            const now = Date.now();
            saveSession(
                projectPath,
                prompt.length > 48 ? `${prompt.slice(0, 48).trim()}…` : prompt,
                [
                    { role: "user", content: prompt, timestamp: now - 1 },
                    { role: "assistant", content: assistant.trim(), timestamp: now },
                ],
            );
        } catch {
            /* session snapshotting is non-essential */
        }
    }

    cliExit(exitCode);
}
