import fs from "node:fs";
import readline from "node:readline";
import { BrowserSession, type DOMContext, formatDOMContext, runOrchestrator } from "@raiken/core";
import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { accent, dim, splitHITL } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";
import { gatherAttentionItems, renderAttentionBanner } from "../repl/attention";
import {
    continueBackgroundDiscover,
    getBackgroundDiscoverStatus,
    startBackgroundDiscover,
} from "../repl/background-discover";
import {
    boxWidth,
    promptBottomBorder,
    promptPrefix,
    promptTopBorder,
    renderBox,
} from "../repl/box";
import {
    booleanFlag,
    type ParsedCommandArgs,
    parseCommandArgs,
    stringFlag,
    stringFlags,
} from "../repl/command-args";
import {
    matchSlashCommands,
    resolveSlashCommand,
    SLASH_COMMAND_REGISTRY,
    type SlashCommandGroup,
    slashCompleter,
} from "../repl/completer";
import { withThrowExit } from "../repl/exit";
import { MarkdownStream } from "../repl/markdown";
import {
    cyclePermissionMode,
    type PermissionMode,
    parsePermissionMode,
    permissionModeLabel,
    permissionModeToAutonomyOverride,
    shouldAutoRun,
    shouldAutoSave,
} from "../repl/permissions";
import { buildAgentPlan, renderPlan } from "../repl/plan";
import { InputQueue } from "../repl/queue";
import {
    type ChatMessage,
    listSessions,
    loadLiveHistory,
    previewMessage,
    resolveResumeTarget,
    saveLiveHistory,
    saveSession,
    setCurrentSessionId,
} from "../repl/sessions";
import { printShellSummary, runShellCommand } from "../repl/shell";
import { SlashMenuOverlay } from "../repl/slash-overlay";
import { gatherStatusSnapshot, renderStatusStrip } from "../repl/status";
import { startThinking } from "../repl/thinking";
import { ToolCallRenderer } from "../repl/tool-renderer";
import { looksLikeApiKey } from "./config";

const HISTORY_LIMIT = 200;
const EXIT_CONFIRM_MS = 2000;

/** Compact DOM summary for /snapshot and after DOM commands. */
function renderSnapshot(dom: DOMContext): void {
    console.log(accent(`\n${dom.title || "(untitled)"}`), dim(`— ${dom.url}`));
    const els = dom.interactiveElements ?? [];
    if (els.length === 0) {
        console.log(dim("  (no interactive elements found)"));
        return;
    }
    for (const el of els.slice(0, 25)) {
        const sel = el.suggestedSelectors?.[0] ?? "";
        console.log(
            `  ${dim("•")} ${el.role}: ${chalk.white(`"${el.name || el.text || ""}"`)} ${dim(sel)}`,
        );
    }
    if (els.length > 25) console.log(dim(`  ... and ${els.length - 25} more`));
}

export interface ChatCommandOptions {
    /** Resume a named session, or `true` for the latest / current. */
    resume?: string | true;
}

export async function chatCommand(options: ChatCommandOptions = {}): Promise<void> {
    const projectPath = process.cwd();
    // The interactive session always drives a visible browser so the tester
    // can watch the agent work the page.
    process.env.RAIKEN_HEADLESS = "0";

    // One line, not a wall of shortcuts — everything below (Ctrl+C ladder,
    // !shell, /plan, Tab-complete, …) is one `/help` away instead of being
    // dumped on every launch.
    console.log(dim("  Type a request, or /help for commands.\n"));

    // Quiet by default: a persistent status strip renders above every prompt
    // (model/mode/pages/etc.), so the raw indexing log this used to print
    // (code graph stats, keyword counts, watcher status, ticket detection…)
    // was redundant noise. A transient spinner covers the one case that
    // still matters to show — first-run indexing taking a moment — without
    // leaving anything behind once it's done.
    const boot = ora({ text: dim("Preparing project…"), color: "magenta" }).start();
    let bootResult: Awaited<ReturnType<typeof bootstrapProject>>;
    try {
        bootResult = await bootstrapProject(projectPath, { verbose: false });
    } finally {
        boot.stop();
    }
    if (!bootResult.ok) {
        console.log(
            chalk.yellow(
                "  ⚠ Code understanding failed to initialize — search, impact analysis, and " +
                    "context lookups will be empty this session (see error above).\n",
            ),
        );
    }

    // Anything left over from a previous session (paused discovery, an
    // unresolved auth blocker, a missing AI key) used to only surface as a
    // confusing failure mid-turn. Surface it once, up front, instead — and
    // only fold in bootstrap's own non-fatal warnings when `ok` (the fatal
    // case above is already its own loud, dedicated message).
    try {
        const attentionItems = await gatherAttentionItems(
            projectPath,
            bootResult.ok ? bootResult.warnings : [],
        );
        renderAttentionBanner(attentionItems);
    } catch {
        /* attention banner is best-effort — never blocks REPL startup */
    }

    const caller = appRouter.createCaller({ projectPath });
    const history: ChatMessage[] = [];
    let activeSessionName: string | null = null;

    // Resume path: explicit flag, else restore live history (existing behavior).
    if (options.resume !== undefined) {
        const target = resolveResumeTarget(
            projectPath,
            options.resume === true ? undefined : options.resume,
        );
        if (target.messages.length === 0 && options.resume !== true) {
            console.log(chalk.yellow(`  No session found for "${options.resume}".`));
            console.log(dim("  Use /sessions to list saved threads.\n"));
        } else if (target.messages.length > 0) {
            history.push(...target.messages);
            activeSessionName = target.session?.name ?? null;
            if (target.session) setCurrentSessionId(projectPath, target.session.id);
            saveLiveHistory(projectPath, history);
            console.log(
                dim(
                    `  Resumed "${target.label}"` +
                        `  ·  ${history.length} messages` +
                        `  ·  ${previewMessage(history)}\n`,
                ),
            );
        }
    } else {
        const live = loadLiveHistory(projectPath);
        if (live.length > 0) {
            history.push(...live);
            console.log(dim(`  Restored ${history.length} messages from previous session.\n`));
        }
    }

    let permissionMode: PermissionMode = "ask";
    let planMode = false;
    let verboseTools = false;
    const tools = new ToolCallRenderer({ verbose: false });
    const inputQueue = new InputQueue();

    let currentAbort: AbortController | null = null;
    // Set while a cancelable prompt (HITL) is waiting, so Ctrl-C cancels just
    // that prompt instead of tearing down the session.
    let promptCancel: (() => void) | null = null;
    // A single input dispatcher for every REPL-native wizard/HITL prompt.
    // Register its receiver before writing the prompt so an answer can never
    // land in `pendingLines` during the handoff between adjacent prompts.
    let activePromptAnswer: ((line: string) => void) | null = null;
    // Lines typed while no `askCancelable` prompt is actively listening (e.g.
    // the split second between one wizard question and the next, while an
    // `await` in between — like a live model-catalog fetch — hasn't resumed
    // yet) get buffered here instead of silently dropped. The next
    // `askCancelable` call drains from this before waiting for a fresh
    // keystroke, so answering "ahead" of a prompt still lands on the right
    // question instead of vanishing into a prompt nobody's listening for yet.
    const pendingLines: string[] = [];
    let closing = false;
    let exitArmedUntil = 0;
    /** True while an agent turn is streaming — stdin lines go to the queue. */
    let turnActive = false;
    /** True only while readline is collecting the main chat prompt. */
    let readingUserInput = false;
    // Covers the silent gap between submitting a turn and the first token /
    // tool call / progress line — otherwise the prompt just looks frozen
    // while the orchestrator's first (often multi-second) classification
    // call is in flight. Cleared by the first thing that actually prints.
    let thinking: ReturnType<typeof startThinking> | null = null;
    const stopThinking = (): void => {
        thinking?.stop();
        thinking = null;
    };

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        historySize: HISTORY_LIMIT,
        terminal: true,
        completer: slashCompleter,
    });

    let activeReadlinePrompt = "";
    const slashOverlay = new SlashMenuOverlay(process.stdout);
    let slashSyncScheduled = false;

    const currentSlashOverlayState = () => ({
        enabled: readingUserInput,
        line: rl.line,
        cursor: rl.cursor,
        cursorRows: rl.getCursorPos().rows,
        prompt: activeReadlinePrompt,
    });

    // Readline updates `rl.line` before this listener runs. Coalesce rapid
    // keypresses, then keep the ephemeral menu synchronized with the complete
    // command token (`/` → `/d` → `/do`), including backspace and history.
    const handleKeypress = (_input: string, key: readline.Key): void => {
        if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
            return;
        }
        if (!readingUserInput || slashSyncScheduled) return;
        slashSyncScheduled = true;
        setImmediate(() => {
            slashSyncScheduled = false;
            slashOverlay.sync(currentSlashOverlayState());
        });
    };
    const handleTerminalResize = (): void => {
        if (readingUserInput) slashOverlay.sync(currentSlashOverlayState());
    };
    process.stdin.on("keypress", handleKeypress);
    process.stdout.on("resize", handleTerminalResize);

    const ask = (query: string): Promise<string> =>
        new Promise((resolve) => {
            activeReadlinePrompt = query;
            rl.question(query, (answer) => {
                activeReadlinePrompt = "";
                resolve(answer);
            });
        });

    const createManualSaveWatcher = () => {
        let settled = false;
        let resolvePromise: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
            resolvePromise = resolve;
        });
        const finish = () => {
            if (settled) return;
            settled = true;
            rl.off("line", finish);
            resolvePromise();
        };
        rl.once("line", finish);
        return {
            promise,
            cancel: () => {
                settled = true;
                rl.off("line", finish);
            },
        };
    };

    const persist = () => saveLiveHistory(projectPath, history);

    const ensureBrowser = async (): Promise<BrowserSession> => {
        const session = BrowserSession.getInstance(projectPath);
        if (!session.isActive()) {
            try {
                await session.start({ headless: false });
            } catch (err) {
                if (isMissingBrowserError(err)) {
                    printPlaywrightInstallHint();
                }
                throw err;
            }
        }
        return session;
    };

    const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        persist();
        if (activeSessionName) {
            try {
                saveSession(projectPath, activeSessionName, history, permissionMode);
            } catch {
                /* best-effort */
            }
        }
        console.log(dim("\n  Closing browser and exiting..."));
        try {
            await BrowserSession.getInstance(projectPath).close();
        } catch {
            /* already closed */
        }
        rl.close();
        process.stdin.off("keypress", handleKeypress);
        process.stdout.off("resize", handleTerminalResize);
        process.exit(0);
    };

    /**
     * Claude/Codex-style interrupt ladder:
     *   1. Abort in-flight agent turn
     *   2. Cancel pending HITL / cancelable prompt
     *   3. Idle: arm exit (print hint); second Ctrl+C within 2s exits
     */
    const handleInterrupt = (): void => {
        if (readingUserInput && slashOverlay.visible) {
            slashOverlay.hide(currentSlashOverlayState());
        }
        if (currentAbort) {
            stopThinking();
            currentAbort.abort();
            currentAbort = null;
            exitArmedUntil = 0;
            console.log(chalk.yellow("\n  ⏹  Stopped the current run."));
            return;
        }
        if (promptCancel) {
            promptCancel();
            exitArmedUntil = 0;
            return;
        }
        const now = Date.now();
        if (now < exitArmedUntil) {
            void shutdown();
            return;
        }
        exitArmedUntil = now + EXIT_CONFIRM_MS;
        console.log(dim("\n  Press Ctrl+C again to exit"));
    };

    rl.on("SIGINT", handleInterrupt);

    // While a turn is active, lines typed at the terminal are queued for the
    // next turn (Codex Tab-queue pattern) instead of being lost. Otherwise —
    // no turn running, and no `askCancelable` prompt currently attached to
    // listen for it — buffer it (see `pendingLines` above) rather than
    // dropping it on the floor.
    rl.on("line", (line: string) => {
        if (activePromptAnswer) {
            activePromptAnswer(line);
            return;
        }
        // `readUserInput` has its own `rl.question` listener. Do not also
        // buffer its just-submitted chat command/message here: it is already
        // being delivered to the main loop, and treating it as the first
        // answer of the next interactive command would misroute `/config`
        // into the provider picker.
        if (readingUserInput) return;
        if (turnActive) {
            const n = inputQueue.enqueue(line);
            if (n > 0) {
                const preview = line.trim().slice(0, 48);
                console.log(
                    dim(`  ↳ queued (${n}): ${preview}${line.trim().length > 48 ? "…" : ""}`),
                );
            }
            return;
        }
        pendingLines.push(line);
    });

    rl.on("close", () => {
        void shutdown();
    });

    const askCancelable = (query: string, secret = false): Promise<string | null> => {
        const buffered = pendingLines.shift();
        if (buffered !== undefined) {
            process.stdout.write(`${query}${secret ? "••••" : buffered}\n`);
            return Promise.resolve(buffered);
        }
        return new Promise((resolve) => {
            let settled = false;
            const settle = (answer: string | null) => {
                if (settled) return;
                settled = true;
                activePromptAnswer = null;
                promptCancel = null;
                resolve(answer);
            };
            // The dispatcher is active before the prompt is rendered. The old
            // per-prompt `rl.on("line")` listener left a small but real gap
            // after `process.stdout.write(query)`: a line received there was
            // buffered and this prompt then waited forever.
            activePromptAnswer = (line) => settle(line);
            promptCancel = () => {
                settle(null);
                console.log(chalk.yellow("\n  ⏹  Cancelled."));
            };
            process.stdout.write(query);
        });
    };

    /**
     * Ask for a secret through the existing readline instance. A second
     * readline (for example Inquirer's `password`) cannot safely coexist with
     * the REPL, because it takes raw-mode ownership and leaves the slash menu
     * / main input out of sync. Readline's output hook is the supported Node
     * escape hatch for password-style input; it keeps the actual answer in
     * memory while replacing terminal echo with bullets.
     */
    const askSecret = async (query: string): Promise<string | null> => {
        type ReadlineWithOutputHook = typeof rl & {
            _writeToOutput?: (value: string) => void;
        };
        const mutableReadline = rl as ReadlineWithOutputHook;
        const originalWrite = mutableReadline._writeToOutput;
        if (!originalWrite || !process.stdin.isTTY) return askCancelable(query, true);

        mutableReadline._writeToOutput = (value: string) => {
            // Readline writes the editable row (and cursor-control escape
            // sequences) through this hook. Never forward the original value:
            // it contains the API key. A bullet keeps the field visibly
            // active while masking the key itself.
            if (value.includes("\n") || value.includes("\r")) {
                originalWrite.call(rl, "\n");
            } else if (value.length > 0) {
                originalWrite.call(rl, "•");
            }
        };
        try {
            return await askCancelable(query, true);
        } finally {
            mutableReadline._writeToOutput = originalWrite;
        }
    };

    /** Read a prompt, supporting `\` + Enter for multiline continuation. */
    const readUserInput = async (): Promise<string | null> => {
        // Back at the idle top-level prompt — any input a prior wizard's
        // `askCancelable` steps left unclaimed (e.g. it ended before draining
        // everything typed ahead of it) belongs to that command, not to
        // whatever's typed next, so don't carry it forward.
        pendingLines.length = 0;
        const snap = await gatherStatusSnapshot(projectPath, permissionMode, planMode);
        console.log("");
        renderStatusStrip(snap);
        if (inputQueue.length > 0) {
            console.log(dim(`  ${inputQueue.length} queued — draining next`));
        }
        if (activeSessionName) {
            console.log(dim(`  session: ${activeSessionName}`));
        }

        const width = boxWidth();
        console.log(promptTopBorder(width));

        const lines: string[] = [];
        let prompt = promptPrefix();
        readingUserInput = true;
        slashOverlay.reset();
        try {
            for (;;) {
                const raw = await ask(prompt);
                slashOverlay.finish(prompt, raw);
                if (closing) return null;
                if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
                    lines.push(raw.slice(0, -1));
                    prompt = promptPrefix(true);
                    continue;
                }
                lines.push(raw);
                break;
            }
        } finally {
            readingUserInput = false;
        }
        console.log(promptBottomBorder(width));
        return lines.join("\n").trim();
    };

    const saveTestToDisk = async (
        testCode: string,
        suggestedPath: string,
    ): Promise<string | null> => {
        if (!suggestedPath) {
            console.log(chalk.red("  No path — not saved."));
            return null;
        }
        const lastSlash = suggestedPath.lastIndexOf("/");
        const testDir = lastSlash >= 0 ? suggestedPath.slice(0, lastSlash) : undefined;
        const fileName = lastSlash >= 0 ? suggestedPath.slice(lastSlash + 1) : suggestedPath;
        try {
            const result = await caller.saveGeneratedTest({ fileName, content: testCode, testDir });
            console.log(chalk.green(`  ✓ Saved ${result.filePath}`));
            return result.filePath;
        } catch (err) {
            console.log(chalk.red(`  ✗ Save failed: ${err instanceof Error ? err.message : err}`));
            return null;
        }
    };

    const runSavedTest = async (filePath: string): Promise<void> => {
        console.log(dim(`  Running ${filePath}...`));
        try {
            const result = (await caller.runTests({ testFile: filePath })) as {
                success: boolean;
                stderr?: string;
                results?: {
                    stats?: { expected?: number; unexpected?: number; skipped?: number };
                } | null;
            };
            const stats = result.results?.stats;
            const passed = stats?.expected ?? 0;
            const failed = stats?.unexpected ?? 0;
            console.log(
                `  ${result.success ? chalk.green("✓ passed") : chalk.red("✗ failed")}` +
                    dim(`  (${passed} passed, ${failed} failed)`),
            );
            if (!result.success && result.stderr) {
                console.log(dim(result.stderr.split("\n").slice(0, 5).join("\n")));
            }
        } catch (err) {
            console.log(chalk.red(`  ✗ Run failed: ${err instanceof Error ? err.message : err}`));
        }
    };

    const handleSaveApproval = async (hitl: Record<string, unknown>): Promise<void> => {
        const testCode = typeof hitl.testCode === "string" ? hitl.testCode : "";
        let suggestedPath = typeof hitl.suggestedPath === "string" ? hitl.suggestedPath : "";
        const context =
            hitl.context && typeof hitl.context === "object"
                ? (hitl.context as Record<string, unknown>)
                : {};
        const workflowId = typeof context.workflowId === "string" ? context.workflowId : undefined;
        if (!testCode) return;

        if (shouldAutoSave(permissionMode)) {
            console.log(
                `\n  ${accent("⏺")} ${chalk.bold.white("Auto-saving")}` +
                    dim(`  ${suggestedPath || "(no path)"}`) +
                    dim(`  ·  ${permissionModeLabel(permissionMode)}`),
            );
            const saved = await saveTestToDisk(testCode, suggestedPath);
            if (saved && shouldAutoRun(permissionMode)) {
                await runSavedTest(saved);
            }
            return;
        }

        const codeLines = testCode.split("\n");
        const preview = codeLines.slice(0, 8).map((l) => chalk.white(l));
        if (codeLines.length > 8) preview.push(dim("..."));
        console.log("");
        console.log(
            renderBox([
                `${accent("Save test?")}  ${dim(suggestedPath || "(no path)")}`,
                "",
                ...preview,
            ]),
        );

        const rawAnswer = await askCancelable(
            `  ${accent("[Y]es · [e]dit path · [r]un · [n]o ›")} `,
        );
        if (rawAnswer === null) return;
        const answer = rawAnswer.trim().toLowerCase();
        if (answer === "n" || answer === "no") {
            if (workflowId) {
                await caller.continueHitlWorkflow({
                    workflowId,
                    action: "save",
                    decision: "reject",
                });
            }
            console.log(dim("  Discarded."));
            return;
        }

        const alsoRun = answer === "r" || answer === "run";
        if (answer === "e" || answer === "edit") {
            const p = await askCancelable("  New path › ");
            if (p === null) return;
            if (p.trim()) suggestedPath = p.trim();
        }

        if (workflowId) {
            const result = await caller.continueHitlWorkflow({
                workflowId,
                action: "save",
                decision: "approve",
                filePath: suggestedPath,
            });
            const saved = result.savedPath;
            if (saved && alsoRun && result.workflow.status === "await_run_approval") {
                await caller.continueHitlWorkflow({
                    workflowId,
                    action: "run",
                    decision: "approve",
                });
            }
            return;
        }
        const saved = await saveTestToDisk(testCode, suggestedPath);
        if (saved && alsoRun) await runSavedTest(saved);
    };

    /**
     * Handle a `run_approval` pause (the test is already saved; the agent
     * wants to run it but `autoRunTests` isn't on). Mirrors
     * `handleSaveApproval` — this used to be entirely unhandled (the REPL
     * captured the `run_approval` marker but never acted on it), so a run
     * pause was a dead end: the turn just ended and the user had to notice
     * and run `/test <path>` themselves.
     */
    const handleRunApproval = async (hitl: Record<string, unknown>): Promise<void> => {
        const testFile = typeof hitl.testFile === "string" ? hitl.testFile : "";
        const testName = typeof hitl.testName === "string" ? hitl.testName : testFile;
        const context =
            hitl.context && typeof hitl.context === "object"
                ? (hitl.context as Record<string, unknown>)
                : {};
        const workflowId = typeof context.workflowId === "string" ? context.workflowId : undefined;
        if (!testFile) return;

        if (shouldAutoRun(permissionMode)) {
            console.log(
                `\n  ${accent("⏺")} ${chalk.bold.white("Auto-running")}` +
                    dim(`  ${testFile}`) +
                    dim(`  ·  ${permissionModeLabel(permissionMode)}`),
            );
            await runSavedTest(testFile);
            return;
        }

        console.log("");
        console.log(renderBox([`${accent("Run test?")}  ${dim(testFile)}`, "", dim(testName)]));

        const rawAnswer = await askCancelable(`  ${accent("[Y]es · [n]o ›")} `);
        if (rawAnswer === null) return;
        const answer = rawAnswer.trim().toLowerCase();
        if (answer === "n" || answer === "no") {
            if (workflowId) {
                await caller.continueHitlWorkflow({
                    workflowId,
                    action: "run",
                    decision: "reject",
                });
            }
            console.log(dim("  Skipped."));
            return;
        }
        if (workflowId) {
            await caller.continueHitlWorkflow({
                workflowId,
                action: "run",
                decision: "approve",
            });
            return;
        }
        await runSavedTest(testFile);
    };

    const runAgentTurn = async (userText: string): Promise<void> => {
        if (planMode) {
            const plan = await buildAgentPlan(projectPath, userText);
            renderPlan(plan);
            const confirm = await askCancelable(accent("  Proceed? [Y]es · [n]o · [p]lan off › "));
            if (confirm === null) return;
            const a = confirm.trim().toLowerCase();
            if (a === "n" || a === "no") {
                console.log(dim("  Cancelled."));
                return;
            }
            if (a === "p" || a === "plan" || a === "off") {
                planMode = false;
                console.log(dim("  Plan mode off — running this turn."));
            }
        }

        const priorHistory = [...history];
        history.push({ role: "user", content: userText });

        const abort = new AbortController();
        currentAbort = abort;
        turnActive = true;
        exitArmedUntil = 0;
        let assistant = "";
        let pendingHITL: Record<string, unknown> | null = null;
        tools.setVerbose(verboseTools);
        const md = new MarkdownStream();

        thinking = startThinking();
        try {
            const stream = runOrchestrator({
                userPrompt: userText,
                projectPath,
                conversationHistory: priorHistory,
                // Session-scoped only — never rewrites raiken.config.json — so
                // `/mode` actually changes what the graph does instead of just
                // relabeling the status strip while it keeps reading whatever
                // autoSaveTests/autoRunTests happen to be on disk.
                autonomyOverride: permissionModeToAutonomyOverride(permissionMode),
                signal: abort.signal,
                origin: "repl",
                onToolCall: (name, args) => {
                    stopThinking();
                    tools.onToolCall(name, args);
                },
            });
            for await (const chunk of stream) {
                const { text, hitl } = splitHITL(chunk, {
                    onProgress: (label, detail) => {
                        stopThinking();
                        tools.onProgress(label, detail);
                    },
                    suppressProgressPrint: true,
                });
                if (hitl && (hitl.kind === "save_approval" || hitl.kind === "run_approval")) {
                    pendingHITL = hitl;
                }
                if (text) {
                    stopThinking();
                    tools.flush();
                    if (!assistant) console.log("");
                    md.push(text);
                    assistant += text;
                }
            }
            tools.flush();
            md.end();
            if (!assistant.endsWith("\n")) process.stdout.write("\n");
        } catch (err) {
            stopThinking();
            tools.flush();
            if (abort.signal.aborted) {
                // already reported by SIGINT handler
            } else if (isMissingBrowserError(err)) {
                printPlaywrightInstallHint();
            } else {
                console.log(chalk.red(`\n  ✗ ${err instanceof Error ? err.message : err}`));
            }
        } finally {
            stopThinking();
            turnActive = false;
            currentAbort = null;
        }

        history.push({ role: "assistant", content: assistant });
        persist();
        if (pendingHITL?.kind === "save_approval") {
            await handleSaveApproval(pendingHITL);
        } else if (pendingHITL?.kind === "run_approval") {
            await handleRunApproval(pendingHITL);
        }
    };

    const runParity = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const code = await withThrowExit(fn);
        if (code !== 0) {
            console.log(dim(`  (${label} exited with code ${code})`));
        }
    };

    /**
     * A key pasted into the main chat prompt is already visible in terminal
     * scrollback, so never silently save or send it to the agent. Discard it
     * and enter the canonical setup flow again through its masked prompt.
     */
    const startSecureConfigAfterPastedKey = async (): Promise<void> => {
        console.log(
            chalk.yellow(
                "\n  API keys are entered through the masked `/config` prompt, not the chat prompt.",
            ),
        );
        console.log(dim("  The pasted value was not saved or sent to the AI provider.\n"));
        const { configCommand } = await import("./config");
        await runParity("config", () =>
            configCommand(undefined, {
                fromRepl: true,
                replAsk: askCancelable,
                replAskSecret: askSecret,
            }),
        );
    };

    const handleShell = async (command: string): Promise<void> => {
        if (!command.trim()) {
            console.log(chalk.red("  usage: !<shell command>"));
            return;
        }
        console.log(dim(`  $ ${command}`));
        const result = await runShellCommand(command, projectPath);
        printShellSummary(result);
    };

    const domCommands: Record<string, (arg: string) => Promise<void>> = {
        goto: async (arg) => {
            if (!arg) return void console.log(chalk.red("  usage: /goto <url>"));
            const session = await ensureBrowser();
            const dom = await session.navigate(arg);
            renderSnapshot(dom);
        },
        click: async (arg) => {
            if (!arg) return void console.log(chalk.red("  usage: /click <selector>"));
            const session = await ensureBrowser();
            await session.click(arg);
            console.log(chalk.green(`  ✓ clicked ${dim(arg)}`));
        },
        fill: async (arg) => {
            const [sel, val] = splitAssign(arg);
            if (!sel || val === undefined)
                return void console.log(chalk.red("  usage: /fill <selector> = <value>"));
            const session = await ensureBrowser();
            await session.fill(sel, val);
            console.log(chalk.green(`  ✓ filled ${dim(sel)}`));
        },
        type: async (arg) => {
            const [sel, val] = splitAssign(arg);
            if (!sel || val === undefined)
                return void console.log(chalk.red("  usage: /type <selector> = <text>"));
            const session = await ensureBrowser();
            await session.type(sel, val);
            console.log(chalk.green(`  ✓ typed into ${dim(sel)}`));
        },
        press: async (arg) => {
            if (!arg) return void console.log(chalk.red("  usage: /press <key>"));
            const session = await ensureBrowser();
            await session.press(arg);
            console.log(chalk.green(`  ✓ pressed ${dim(arg)}`));
        },
        snapshot: async () => {
            const session = await ensureBrowser();
            const dom = await session.captureCurrentPage();
            console.log(formatDOMContext(dom));
        },
        url: async () => {
            const session = BrowserSession.getInstance(projectPath);
            console.log(session.isActive() ? session.getCurrentUrl() : dim("  (no active page)"));
        },
        back: async () => {
            const session = await ensureBrowser();
            const dom = await session.goBack();
            if (dom) renderSnapshot(dom);
            else console.log(dim("  (no history)"));
        },
        reload: async () => {
            const session = await ensureBrowser();
            renderSnapshot(await session.reload());
        },
        screenshot: async () => {
            const session = await ensureBrowser();
            const buf = await session.screenshot();
            const file = `raiken-shot-${Date.now()}.png`;
            fs.writeFileSync(file, buf);
            console.log(chalk.green(`  ✓ saved ${file}`));
        },
    };

    const handleSlash = async (line: string): Promise<void> => {
        const spaceIdx = line.indexOf(" ");
        const enteredCommand = (
            spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)
        ).toLowerCase();
        const cmd = resolveSlashCommand(enteredCommand)?.name ?? enteredCommand;
        const arg = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
        const parsedArgs = parseCommandArgs(arg);

        if (cmd === "" || cmd === "help") return printHelp();
        if (cmd === "exit") return void (await shutdown());

        if (cmd === "mode" || cmd === "permissions") {
            if (arg) {
                const parsed = parsePermissionMode(arg);
                if (!parsed) {
                    console.log(
                        chalk.red(`  Unknown mode: ${arg}`) +
                            dim("  — ask | auto-save | auto-run | yolo"),
                    );
                    return;
                }
                permissionMode = parsed;
            } else {
                permissionMode = cyclePermissionMode(permissionMode);
            }
            console.log(
                dim("  Permission mode: ") +
                    accent(permissionModeLabel(permissionMode)) +
                    dim("  (ask → auto-save → auto-run → yolo)"),
            );
            return;
        }

        if (cmd === "verbose") {
            verboseTools = !verboseTools;
            tools.setVerbose(verboseTools);
            console.log(dim(`  Tool detail: ${verboseTools ? "verbose" : "collapsed"}`));
            return;
        }

        if (cmd === "plan") {
            if (arg === "on" || arg === "1" || arg === "true") planMode = true;
            else if (arg === "off" || arg === "0" || arg === "false") planMode = false;
            else planMode = !planMode;
            console.log(
                dim("  Plan mode: ") +
                    accent(planMode ? "on" : "off") +
                    dim("  — preview steps before the agent runs"),
            );
            return;
        }

        if (cmd === "sessions" || cmd === "session") {
            if (!arg || arg === "list") {
                const sessions = listSessions(projectPath);
                if (sessions.length === 0) {
                    console.log(dim("\n  No saved sessions. Use /save <name> to snapshot.\n"));
                    return;
                }
                console.log(accent("\n  Sessions"));
                for (const s of sessions.slice(0, 20)) {
                    const when = new Date(s.updatedAt).toLocaleString();
                    console.log(
                        `  ${accent(s.name.padEnd(20))} ${dim(`${s.messages.length} msgs · ${when}`)}`,
                    );
                    console.log(`      ${dim(previewMessage(s.messages))}`);
                }
                console.log("");
                return;
            }
            if (arg.startsWith("save ") || arg === "save") {
                const name = arg === "save" ? "" : arg.slice(5).trim();
                if (!name) {
                    console.log(chalk.red("  usage: /sessions save <name>  (or /save <name>)"));
                    return;
                }
                const snap = saveSession(projectPath, name, history, permissionMode);
                activeSessionName = snap.name;
                console.log(
                    chalk.green(`  ✓ Saved session "${snap.name}"`) +
                        dim(`  (${snap.messages.length} messages)`),
                );
                return;
            }
            console.log(dim("  usage: /sessions [list] | /sessions save <name>"));
            return;
        }

        if (cmd === "save") {
            if (!arg) {
                console.log(chalk.red("  usage: /save <name>"));
                return;
            }
            const snap = saveSession(projectPath, arg, history, permissionMode);
            activeSessionName = snap.name;
            console.log(
                chalk.green(`  ✓ Saved session "${snap.name}"`) +
                    dim(`  (${snap.messages.length} messages)`),
            );
            return;
        }

        if (cmd === "resume") {
            const target = resolveResumeTarget(projectPath, arg || undefined);
            if (target.messages.length === 0) {
                console.log(
                    chalk.yellow(
                        arg
                            ? `  No session found for "${arg}".`
                            : "  No sessions to resume. Use /save <name> first.",
                    ),
                );
                return;
            }
            history.length = 0;
            history.push(...target.messages);
            activeSessionName = target.session?.name ?? null;
            if (target.session) setCurrentSessionId(projectPath, target.session.id);
            persist();
            console.log(
                chalk.green(`  ✓ Resumed "${target.label}"`) +
                    dim(`  ·  ${history.length} messages · ${previewMessage(history)}`),
            );
            return;
        }

        if (cmd === "clear") {
            history.length = 0;
            inputQueue.clear();
            activeSessionName = null;
            persist();
            try {
                await caller.clearChatMessages();
            } catch {
                /* memory clear is best-effort */
            }
            console.log(dim("  Conversation context and agent memory cleared."));
            return;
        }

        if (domCommands[cmd]) return domCommands[cmd](arg);

        switch (cmd) {
            case "discover": {
                const action = parsedArgs.positionals[0]?.toLowerCase();
                if (action === "status" || booleanFlag(parsedArgs, "status")) {
                    const st = getBackgroundDiscoverStatus();
                    if (st.status === "idle") {
                        const { discoverCommand } = await import("./discover");
                        await runParity("discover", () =>
                            discoverCommand(undefined, { status: true }),
                        );
                    } else {
                        console.log(
                            accent("\n  Background discover") +
                                dim(
                                    `  ·  ${st.status}  ·  ${st.pages}/${st.maxPages} pages` +
                                        `  ·  ${st.links} links  ·  ${st.startUrl}`,
                                ),
                        );
                        if (st.currentUrl) console.log(dim(`  current: ${st.currentUrl}`));
                        if (st.status === "failed" && st.error) {
                            console.log(chalk.red(`  error: ${st.error}`));
                        }
                        console.log("");
                    }
                    return;
                }
                if (action === "continue" || booleanFlag(parsedArgs, "continue")) {
                    try {
                        await continueBackgroundDiscover(projectPath, {
                            skipAuth: booleanFlag(parsedArgs, "skipAuth"),
                        });
                    } catch (err) {
                        console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}`));
                    }
                    return;
                }
                const url = stringFlag(parsedArgs, "bg") ?? parsedArgs.positionals[0] ?? "";
                if (!url) {
                    console.log(
                        chalk.red("  usage: /discover <url>") +
                            dim("  ·  /discover --continue  ·  /discover status"),
                    );
                    return;
                }
                try {
                    if (booleanFlag(parsedArgs, "auth")) {
                        const { authCommand } = await import("./auth");
                        const authCode = await withThrowExit(() =>
                            authCommand({ url, createManualSaveWatcher }),
                        );
                        if (authCode !== 0) {
                            console.log(dim(`  (auth exited with code ${authCode})`));
                            return;
                        }
                    }
                    await startBackgroundDiscover({
                        url,
                        projectPath,
                        maxPages: positiveIntegerFlag(parsedArgs, "maxPages"),
                        maxDepth: positiveIntegerFlag(parsedArgs, "maxDepth"),
                        timeout: positiveIntegerFlag(parsedArgs, "timeout"),
                        skipAuth: booleanFlag(parsedArgs, "skipAuth"),
                    });
                } catch (err) {
                    console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}`));
                }
                return;
            }
            case "doctor": {
                const { doctorCommand } = await import("./doctor");
                await runParity("doctor", () =>
                    doctorCommand({
                        dir: stringFlag(parsedArgs, "dir"),
                        failOn: stringFlag(parsedArgs, "failOn"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "context": {
                const { contextCommand } = await import("./context");
                await runParity("context", () =>
                    contextCommand({
                        output: stringFlag(parsedArgs, "output"),
                        maxRows: stringFlag(parsedArgs, "maxRows"),
                        impact: !booleanFlag(parsedArgs, "noImpact"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "ci": {
                const { ciCommand } = await import("./ci");
                await runParity("ci", () =>
                    ciCommand({
                        base: stringFlag(parsedArgs, "base"),
                        head: stringFlag(parsedArgs, "head"),
                        staged: booleanFlag(parsedArgs, "staged"),
                        outputDir: stringFlag(parsedArgs, "outputDir"),
                        format: stringFlag(parsedArgs, "format"),
                        confidence: stringFlag(parsedArgs, "confidence"),
                        maxTests: stringFlag(parsedArgs, "maxTests"),
                        timeout: stringFlag(parsedArgs, "timeout"),
                        skipRun: booleanFlag(parsedArgs, "skipRun"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "cover": {
                const target = parsedArgs.positionals.join(" ");
                if (!target) return void console.log(chalk.red("  usage: /cover <target>"));
                const { coverCommand } = await import("./cover");
                await runParity("cover", () =>
                    coverCommand(target, {
                        ticket: stringFlag(parsedArgs, "ticket", "t"),
                        output: stringFlag(parsedArgs, "output", "o"),
                        dir: stringFlag(parsedArgs, "dir"),
                        dryRun: booleanFlag(parsedArgs, "dryRun"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "trace": {
                const { traceCommand } = await import("./trace");
                await runParity("trace", () =>
                    traceCommand(parsedArgs.positionals.join(" ") || undefined, {
                        file: stringFlag(parsedArgs, "file", "f"),
                        minConfidence: stringFlag(parsedArgs, "minConfidence"),
                        limit: stringFlag(parsedArgs, "limit"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "sync": {
                const { syncCommand } = await import("./sync");
                await runParity("sync", () =>
                    syncCommand({ ticket: stringFlag(parsedArgs, "ticket", "t") }),
                );
                return;
            }
            case "auth": {
                const { authCommand } = await import("./auth");
                await runParity("auth", () =>
                    authCommand({
                        url: stringFlag(parsedArgs, "url") ?? parsedArgs.positionals[0],
                        cookie: stringFlag(parsedArgs, "cookie"),
                        domain: stringFlag(parsedArgs, "domain"),
                        storage: stringFlags(parsedArgs, "storage"),
                        fromStateFile: stringFlag(parsedArgs, "fromStateFile"),
                        createManualSaveWatcher,
                    }),
                );
                return;
            }
            case "config": {
                const { configCommand } = await import("./config");
                await runParity("config", () =>
                    configCommand(parsedArgs.positionals[0], {
                        provider: stringFlag(parsedArgs, "provider"),
                        apiKey: stringFlag(parsedArgs, "apiKey"),
                        model: stringFlag(parsedArgs, "model"),
                        baseUrl: stringFlag(parsedArgs, "baseUrl"),
                        unsetKey: booleanFlag(parsedArgs, "unsetKey"),
                        list: booleanFlag(parsedArgs, "list"),
                        json: booleanFlag(parsedArgs, "json"),
                        fromRepl: true,
                        // No flags at all -> a real (REPL-native) wizard
                        // instead of just printing the catalog + a hint.
                        replAsk: askCancelable,
                        replAskSecret: askSecret,
                    }),
                );
                return;
            }
            case "tests": {
                const files = await caller.getGraphFiles({ limit: 500, offset: 0 });
                const specs = files.files.filter((f) => /\.(spec|test|e2e)\.[tj]sx?$/.test(f.path));
                if (specs.length === 0) return void console.log(dim("  No test files found."));
                for (const s of specs.slice(0, 100)) console.log(`  ${dim("•")} ${s.path}`);
                return;
            }
            case "test": {
                const { testCommand } = await import("./test");
                await runParity("test", () =>
                    testCommand(parsedArgs.positionals[0], {
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "report": {
                const { reportCommand } = await import("./report");
                await runParity("report", () =>
                    reportCommand(parsedArgs.positionals[0], {
                        from: stringFlag(parsedArgs, "from"),
                        format: stringFlag(parsedArgs, "format"),
                        output: stringFlag(parsedArgs, "output"),
                        open: booleanFlag(parsedArgs, "open"),
                        json: booleanFlag(parsedArgs, "json"),
                        embedScreenshots: booleanFlag(parsedArgs, "noEmbedScreenshots")
                            ? false
                            : undefined,
                    }),
                );
                return;
            }
            case "status": {
                const { statusCommand } = await import("./status");
                await runParity("status", () =>
                    statusCommand({ json: booleanFlag(parsedArgs, "json") }),
                );
                return;
            }
            case "knowledge": {
                const [ksub, ...krest] = parsedArgs.positionals;
                const { knowledgeCommand } = await import("./knowledge");
                await runParity("knowledge", () =>
                    knowledgeCommand(ksub, krest.join(" ") || undefined, {
                        limit: stringFlag(parsedArgs, "limit"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "search": {
                const query = parsedArgs.positionals.join(" ");
                if (!query) return void console.log(chalk.red("  usage: /search <query>"));
                const { searchCommand } = await import("./search");
                await runParity("search", () =>
                    searchCommand(query, {
                        limit: stringFlag(parsedArgs, "limit"),
                        type: stringFlag(parsedArgs, "type"),
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "memory": {
                const { memoryCommand } = await import("./memory");
                await runParity("memory", () =>
                    memoryCommand(parsedArgs.positionals[0], {
                        json: booleanFlag(parsedArgs, "json"),
                    }),
                );
                return;
            }
            case "index": {
                const { indexCommand } = await import("./indexer");
                await runParity("index", () =>
                    indexCommand({
                        embeddings:
                            booleanFlag(parsedArgs, "embeddings") ||
                            parsedArgs.positionals.includes("embeddings"),
                        force: booleanFlag(parsedArgs, "force"),
                    }),
                );
                return;
            }
            case "organize": {
                const { organizeCommand } = await import("./organize");
                await runParity("organize", () =>
                    organizeCommand({
                        yes: booleanFlag(parsedArgs, "yes", "y"),
                        testsOnly: booleanFlag(parsedArgs, "testsOnly"),
                        configOnly: booleanFlag(parsedArgs, "configOnly"),
                        json: booleanFlag(parsedArgs, "json"),
                        // Use the REPL's own readline for the confirmation —
                        // inquirer's prompt would open a second readline on
                        // stdin (double echo, raw-mode desync on teardown).
                        confirm: async (message) => {
                            const answer = (await ask(`${message} (y/N) `)).trim().toLowerCase();
                            return answer === "y" || answer === "yes";
                        },
                    }),
                );
                return;
            }
            case "hooks": {
                const [sub] = parsedArgs.positionals;
                const hooksType = stringFlag(parsedArgs, "type");
                if (sub === "install") {
                    const { hooksInstallCommand } = await import("./hooks");
                    await runParity("hooks install", () =>
                        hooksInstallCommand({
                            type: hooksType,
                            skipRun: booleanFlag(parsedArgs, "skipRun"),
                            husky: booleanFlag(parsedArgs, "husky"),
                        }),
                    );
                    return;
                }
                if (sub === "uninstall") {
                    const { hooksUninstallCommand } = await import("./hooks");
                    await runParity("hooks uninstall", () =>
                        hooksUninstallCommand({ type: hooksType }),
                    );
                    return;
                }
                if (!sub || sub === "status") {
                    const { hooksStatusCommand } = await import("./hooks");
                    await runParity("hooks status", () => hooksStatusCommand());
                    return;
                }
                console.log(
                    chalk.red(`  Unknown hooks subcommand: ${sub}`) +
                        dim("  — install | uninstall | status"),
                );
                return;
            }
            default: {
                const suggestions = matchSlashCommands(cmd)
                    .map((command) => command.name)
                    .slice(0, 5);
                const hint =
                    suggestions.length > 0
                        ? dim(`  — did you mean ${suggestions.map((s) => `/${s}`).join(", ")}?`)
                        : dim("  — /help for the list");
                console.log(chalk.red(`  Unknown command: /${cmd}`) + hint);
            }
        }
    };

    // ── Main loop ─────────────────────────────────────────────────────────
    while (!closing) {
        // Drain anything typed during the previous turn before prompting.
        let line: string | null = inputQueue.dequeue() ?? null;
        if (line) {
            console.log(`\n${accent("›")} ${line}`);
        } else {
            try {
                line = await readUserInput();
            } catch {
                if (closing) break;
                continue;
            }
        }
        if (line === null || closing) break;
        if (!line) continue;
        exitArmedUntil = 0;
        try {
            if (line.startsWith("!")) await handleShell(line.slice(1).trim());
            else if (line.startsWith("/")) await handleSlash(line);
            else if (looksLikeApiKey(line)) {
                await startSecureConfigAfterPastedKey();
            } else await runAgentTurn(line);
        } catch (err) {
            console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}`));
        }
    }
}

function isMissingBrowserError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return (
        /playwright install/i.test(msg) ||
        /Executable doesn't exist/i.test(msg) ||
        /Failed to launch/i.test(msg)
    );
}

function printPlaywrightInstallHint(): void {
    console.log(
        chalk.yellow("\n  ⚠  Playwright browser isn't installed.") +
            dim("\n     Run ") +
            accent("npx playwright install chromium") +
            dim(" and try again.\n"),
    );
}

function positiveIntegerFlag(parsed: ParsedCommandArgs, name: string): number | undefined {
    const raw = stringFlag(parsed, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

function splitAssign(arg: string): [string, string | undefined] {
    const spaced = arg.indexOf(" = ");
    if (spaced !== -1) {
        return [arg.slice(0, spaced).trim(), arg.slice(spaced + 3)];
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
        return [arg.slice(0, eq).trim(), arg.slice(eq + 1)];
    }
    return [arg.trim(), undefined];
}

function printHelp(): void {
    const row = (c: string, d: string) => console.log(`  ${accent(c.padEnd(24))} ${dim(d)}`);
    console.log(accent("\n  Commands"));
    console.log(dim('  Just type a request in plain English (e.g. "test the login flow").'));
    console.log(dim("  End a line with \\ to continue multiline input."));
    console.log(dim("  Type while a run is in progress to queue the next turn."));
    console.log(dim("  !cmd runs a local shell command (e.g. !git status)."));
    const groups: SlashCommandGroup[] = [
        "Agent",
        "Browser / DOM",
        "Knowledge",
        "Testing",
        "Session",
    ];
    for (const group of groups) {
        console.log(dim(`  ─ ${group} ─`));
        for (const command of SLASH_COMMAND_REGISTRY.filter((item) => item.group === group)) {
            const usage = `/${command.name}${command.argsHint ? ` ${command.argsHint}` : ""}`;
            const aliases = command.aliases?.length
                ? ` (alias: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
                : "";
            row(usage, `${command.description}${aliases}`);
        }
    }
    console.log(dim("  ─ Standalone terminal commands ─"));
    row("raiken init", "initialize Raiken in a project");
    row("raiken start", "start the dashboard and API server");
    row('raiken -p "..."', "run one non-interactive agent request");
    row("raiken --help", "show every standalone option and flag");
    console.log(dim("\n  Ctrl+C  stop run → cancel prompt → press again to exit"));
    console.log(dim("  Tab completes /commands  ·  raiken resume [name]\n"));
}
