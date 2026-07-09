import { BrowserSession, runOrchestrator } from "@raiken/core";
import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import { dim, renderToolCall, routeDiagnosticsToStderr, splitHITL } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";
import { createEventStream, nowTs } from "../repl/events";

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

    const fail = (message: string, code = 1): never => {
        if (streamJson) {
            events.emit({ type: "done", ok: false, error: message, ts: nowTs() });
        }
        restoreConsole();
        if (json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
        } else if (!streamJson) {
            process.stderr.write(chalk.red(`\n  ✗ ${message}\n`));
        }
        process.exit(code);
    };

    let prompt = (options.prompt || "").trim();
    if (!prompt) prompt = (await readStdin()).trim();
    if (!prompt) {
        return void fail(
            'No prompt provided. Use: raiken -p "test the login flow"  (or pipe input on stdin).',
        );
    }

    await bootstrapProject(projectPath, {
        watch: false,
        verbose: !json && !streamJson,
    });

    const caller = appRouter.createCaller({ projectPath });

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
            if (hitl && hitl.kind === "save_approval") {
                pendingHITL = hitl;
                if (streamJson) {
                    events.emit({
                        type: "hitl",
                        kind: String(hitl.kind),
                        payload: {
                            suggestedPath: hitl.suggestedPath,
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
        if (abort.signal.aborted) return void fail("Run aborted.", 130);
        return void fail(err instanceof Error ? err.message : String(err));
    } finally {
        if (timer) clearTimeout(timer);
        process.off("SIGINT", onSigint);
    }

    let savedTest: string | null = null;
    if (pendingHITL && options.save) {
        const testCode = typeof pendingHITL.testCode === "string" ? pendingHITL.testCode : "";
        const suggestedPath =
            typeof pendingHITL.suggestedPath === "string" ? pendingHITL.suggestedPath : "";
        if (testCode && suggestedPath) {
            const lastSlash = suggestedPath.lastIndexOf("/");
            const testDir = lastSlash >= 0 ? suggestedPath.slice(0, lastSlash) : undefined;
            const fileName = lastSlash >= 0 ? suggestedPath.slice(lastSlash + 1) : suggestedPath;
            try {
                const result = await caller.saveGeneratedTest({
                    fileName,
                    content: testCode,
                    testDir,
                    avoidOverwrite: true,
                });
                savedTest = result.filePath;
                if (!json && !streamJson) {
                    process.stderr.write(chalk.green(`\n  ✓ Saved ${savedTest}\n`));
                }
            } catch (err) {
                if (!json && !streamJson) {
                    process.stderr.write(
                        chalk.red(
                            `\n  ✗ Save failed: ${err instanceof Error ? err.message : err}\n`,
                        ),
                    );
                }
            }
        }
    }

    if (!savedTest && agentSavedPath) savedTest = agentSavedPath;

    let runSummary: RunSummary | null = null;
    if (options.run && savedTest) {
        if (!json && !streamJson) process.stderr.write(dim(`  Running ${savedTest}...\n`));
        try {
            const result = (await caller.runTests({ testFile: savedTest })) as {
                success: boolean;
                results?: {
                    stats?: { expected?: number; unexpected?: number; skipped?: number };
                } | null;
            };
            const stats = result.results?.stats;
            runSummary = {
                success: result.success,
                passed: stats?.expected ?? 0,
                failed: stats?.unexpected ?? 0,
                skipped: stats?.skipped ?? 0,
            };
            if (!json && !streamJson) {
                const badge = runSummary.success ? chalk.green("✓ passed") : chalk.red("✗ failed");
                process.stderr.write(
                    `  ${badge}${dim(` (${runSummary.passed} passed, ${runSummary.failed} failed)`)}\n`,
                );
            }
        } catch (err) {
            if (!json && !streamJson) {
                process.stderr.write(
                    chalk.red(`  ✗ Run failed: ${err instanceof Error ? err.message : err}\n`),
                );
            }
            runSummary = { success: false, passed: 0, failed: 0, skipped: 0 };
        }
    }

    try {
        await BrowserSession.getInstance(projectPath).close();
    } catch {
        /* already closed */
    }

    if (streamJson) {
        events.emit({
            type: "done",
            ok: true,
            response: assistant.trim(),
            savedTest,
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
                        ok: true,
                        prompt,
                        response: assistant.trim(),
                        toolCalls,
                        savedTest,
                        run: runSummary,
                    },
                    null,
                    2,
                )}\n`,
            );
        }
    }

    const exitCode = runSummary && !runSummary.success ? 1 : 0;
    process.exit(exitCode);
}
