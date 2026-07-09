import fs from "node:fs";
import readline from "node:readline";
import { BrowserSession, type DOMContext, formatDOMContext, runOrchestrator } from "@raiken/core";
import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { accent, dim, splitHITL } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";
import {
    continueBackgroundDiscover,
    getBackgroundDiscoverStatus,
    startBackgroundDiscover,
} from "../repl/background-discover";
import { slashCompleter } from "../repl/completer";
import { withThrowExit } from "../repl/exit";
import {
    cyclePermissionMode,
    type PermissionMode,
    parsePermissionMode,
    permissionModeLabel,
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
import { gatherStatusSnapshot, renderStatusStrip } from "../repl/status";
import { ToolCallRenderer } from "../repl/tool-renderer";

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
    try {
        await bootstrapProject(projectPath, { verbose: false });
    } finally {
        boot.stop();
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
    let closing = false;
    let exitArmedUntil = 0;
    /** True while an agent turn is streaming — stdin lines go to the queue. */
    let turnActive = false;
    // Covers the silent gap between submitting a turn and the first token /
    // tool call / progress line — otherwise the prompt just looks frozen
    // while the orchestrator's first (often multi-second) classification
    // call is in flight. Cleared by the first thing that actually prints.
    let thinkingSpinner: ReturnType<typeof ora> | null = null;
    const stopThinking = (): void => {
        thinkingSpinner?.stop();
        thinkingSpinner = null;
    };

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        historySize: HISTORY_LIMIT,
        terminal: true,
        completer: slashCompleter,
    });

    const ask = (query: string): Promise<string> =>
        new Promise((resolve) => rl.question(query, resolve));

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
        process.exit(0);
    };

    /**
     * Claude/Codex-style interrupt ladder:
     *   1. Abort in-flight agent turn
     *   2. Cancel pending HITL / cancelable prompt
     *   3. Idle: arm exit (print hint); second Ctrl+C within 2s exits
     */
    const handleInterrupt = (): void => {
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
    // next turn (Codex Tab-queue pattern) instead of being lost.
    rl.on("line", (line: string) => {
        if (!turnActive || promptCancel) return;
        const n = inputQueue.enqueue(line);
        if (n > 0) {
            const preview = line.trim().slice(0, 48);
            console.log(dim(`  ↳ queued (${n}): ${preview}${line.trim().length > 48 ? "…" : ""}`));
        }
    });

    rl.on("close", () => {
        void shutdown();
    });

    const askCancelable = (query: string): Promise<string | null> =>
        new Promise((resolve) => {
            process.stdout.write(query);
            const onLine = (line: string) => {
                cleanup();
                resolve(line);
            };
            const cleanup = () => {
                rl.off("line", onLine);
                promptCancel = null;
            };
            promptCancel = () => {
                cleanup();
                console.log(chalk.yellow("\n  ⏹  Cancelled."));
                resolve(null);
            };
            rl.on("line", onLine);
        });

    /** Read a prompt, supporting `\` + Enter for multiline continuation. */
    const readUserInput = async (): Promise<string | null> => {
        const snap = await gatherStatusSnapshot(projectPath, permissionMode, planMode);
        console.log("");
        renderStatusStrip(snap);
        if (inputQueue.length > 0) {
            console.log(dim(`  ${inputQueue.length} queued — draining next`));
        }
        if (activeSessionName) {
            console.log(dim(`  session: ${activeSessionName}`));
        }

        const lines: string[] = [];
        let prompt = accent("raiken › ");
        for (;;) {
            const raw = await ask(prompt);
            if (closing) return null;
            if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
                lines.push(raw.slice(0, -1));
                prompt = dim("     … ");
                continue;
            }
            lines.push(raw);
            break;
        }
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
        if (!testCode) return;

        if (shouldAutoSave(permissionMode)) {
            console.log(
                accent(`\n  ┌─ Auto-saving`) +
                    dim(`  ${suggestedPath || "(no path)"}`) +
                    dim(`  ·  ${permissionModeLabel(permissionMode)}`),
            );
            const saved = await saveTestToDisk(testCode, suggestedPath);
            if (saved && shouldAutoRun(permissionMode)) {
                await runSavedTest(saved);
            }
            return;
        }

        console.log(accent(`\n  ┌─ Save test?`) + dim(`  ${suggestedPath || "(no path)"}`));
        for (const line of testCode.split("\n").slice(0, 8)) {
            console.log(dim(`  │ `) + line);
        }
        if (testCode.split("\n").length > 8) console.log(dim("  │ ..."));

        const rawAnswer = await askCancelable(accent("  └─ [Y]es · [e]dit path · [r]un · [n]o › "));
        if (rawAnswer === null) return;
        const answer = rawAnswer.trim().toLowerCase();
        if (answer === "n" || answer === "no") {
            console.log(dim("  Discarded."));
            return;
        }

        const alsoRun = answer === "r" || answer === "run";
        if (answer === "e" || answer === "edit") {
            const p = await askCancelable("  New path › ");
            if (p === null) return;
            if (p.trim()) suggestedPath = p.trim();
        }

        const saved = await saveTestToDisk(testCode, suggestedPath);
        if (saved && alsoRun) await runSavedTest(saved);
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

        thinkingSpinner = ora({ text: dim("Thinking…"), color: "magenta" }).start();
        try {
            const stream = runOrchestrator({
                userPrompt: userText,
                projectPath,
                conversationHistory: priorHistory,
                signal: abort.signal,
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
                    process.stdout.write(text);
                    assistant += text;
                }
            }
            tools.flush();
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
        }
    };

    const runParity = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const code = await withThrowExit(fn);
        if (code !== 0) {
            console.log(dim(`  (${label} exited with code ${code})`));
        }
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
        const cmd = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)).toLowerCase();
        const arg = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

        if (cmd === "" || cmd === "help" || cmd === "?") return printHelp();
        if (cmd === "exit" || cmd === "quit") return void (await shutdown());

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
                if (arg === "status" || arg.startsWith("--status")) {
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
                                    `  ·  ${st.status}  ·  ${st.pages}/${st.maxPages}  ·  ${st.startUrl}`,
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
                if (arg === "--continue" || arg === "continue") {
                    try {
                        await continueBackgroundDiscover(projectPath);
                    } catch (err) {
                        console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}`));
                    }
                    return;
                }
                const url = arg.replace(/^--bg\s+/, "").trim();
                if (!url) {
                    console.log(
                        chalk.red("  usage: /discover <url>") +
                            dim("  ·  /discover --continue  ·  /discover status"),
                    );
                    return;
                }
                try {
                    await startBackgroundDiscover({ url, projectPath });
                } catch (err) {
                    console.log(chalk.red(`  ✗ ${err instanceof Error ? err.message : err}`));
                }
                return;
            }
            case "doctor": {
                const { doctorCommand } = await import("./doctor");
                await runParity("doctor", () => doctorCommand({}));
                return;
            }
            case "context": {
                const { contextCommand } = await import("./context");
                await runParity("context", () => contextCommand({}));
                return;
            }
            case "ci": {
                const { ciCommand } = await import("./ci");
                await runParity("ci", () => ciCommand({}));
                return;
            }
            case "cover": {
                if (!arg) return void console.log(chalk.red("  usage: /cover <target>"));
                const { coverCommand } = await import("./cover");
                await runParity("cover", () => coverCommand(arg, {}));
                return;
            }
            case "trace": {
                const { traceCommand } = await import("./trace");
                await runParity("trace", () => traceCommand(arg || undefined, {}));
                return;
            }
            case "sync": {
                const { syncCommand } = await import("./sync");
                await runParity("sync", () => syncCommand({}));
                return;
            }
            case "auth": {
                const { authCommand } = await import("./auth");
                await runParity("auth", () => authCommand(arg ? { url: arg } : {}));
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
                console.log(dim(`  Running tests${arg ? ` for ${arg}` : ""}...`));
                const result = (await caller.runTests(arg ? { testFile: arg } : {})) as {
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
                return;
            }
            case "report": {
                console.log(dim(`  Running tests${arg ? ` for ${arg}` : ""} and building report…`));
                const run = (await caller.runTests(arg ? { testFile: arg } : {})) as {
                    success: boolean;
                    stdout?: string;
                    stderr?: string;
                    results?: unknown;
                };
                if (!run.results) {
                    console.log(chalk.red("  ✗ No parseable report was produced."));
                    if (run.stderr) console.log(dim(run.stderr.split("\n").slice(0, 5).join("\n")));
                    return;
                }
                const rep = (await caller.generateTestReport({
                    report: run.results,
                    rawOutput: run.stdout,
                    testFile: arg || undefined,
                    formats: ["html", "json"],
                })) as { htmlPath?: string; files: string[]; screenshotsEmbedded: number };
                console.log(
                    chalk.green(`  Report: ${rep.htmlPath ?? rep.files[0]}`) +
                        dim(`  (${rep.screenshotsEmbedded} screenshot(s) embedded)`),
                );
                return;
            }
            case "status": {
                const { statusCommand } = await import("./status");
                await runParity("status", () => statusCommand({}));
                return;
            }
            case "knowledge":
            case "kb": {
                const [ksub, ...krest] = arg.split(/\s+/).filter(Boolean);
                const { knowledgeCommand } = await import("./knowledge");
                await runParity("knowledge", () =>
                    knowledgeCommand(ksub || undefined, krest.join(" ") || undefined, {}),
                );
                return;
            }
            case "search": {
                if (!arg) return void console.log(chalk.red("  usage: /search <query>"));
                const { searchCommand } = await import("./search");
                await runParity("search", () => searchCommand(arg, {}));
                return;
            }
            case "memory": {
                const { memoryCommand } = await import("./memory");
                await runParity("memory", () => memoryCommand(arg || undefined, {}));
                return;
            }
            case "index": {
                const { indexCommand } = await import("./indexer");
                await runParity("index", () =>
                    indexCommand({ embeddings: /embeddings/.test(arg) }),
                );
                return;
            }
            default: {
                const known = [
                    "discover",
                    "doctor",
                    "context",
                    "ci",
                    "cover",
                    "trace",
                    "sync",
                    "auth",
                    "tests",
                    "test",
                    "status",
                    "knowledge",
                    "search",
                    "memory",
                    "index",
                    "mode",
                    "plan",
                    "verbose",
                    "sessions",
                    "save",
                    "resume",
                ];
                const suggestions = known.filter((k) => k.startsWith(cmd)).slice(0, 5);
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
            console.log(accent("\nraiken › ") + line);
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
            else await runAgentTurn(line);
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
    console.log(dim("  ─ Agent ─"));
    console.log(dim('  Just type a request in plain English (e.g. "test the login flow").'));
    console.log(dim("  End a line with \\ to continue multiline input."));
    console.log(dim("  Type while a run is in progress to queue the next turn."));
    console.log(dim("  !cmd runs a local shell command (e.g. !git status)."));
    console.log(dim("  ─ Browser / DOM ─"));
    row("/goto <url>", "navigate to a URL");
    row("/click <selector>", "click an element");
    row("/fill <sel> = <value>", "fill an input");
    row("/type <sel> = <text>", "type into an element");
    row("/press <key>", "press a key (e.g. Enter)");
    row("/snapshot", "print the current page's DOM");
    row("/url", "show the current URL");
    row("/back  /reload", "history back / reload");
    row("/screenshot", "save a PNG of the page");
    console.log(dim("  ─ Knowledge ─"));
    row("/status", "project setup at a glance");
    row("/discover [url]", "crawl in background (keep chatting)");
    row("/discover status", "show crawl progress / last session");
    row("/discover --continue", "resume a paused crawl in background");
    row("/knowledge [section]", "inspect discovered pages/links/blockers");
    row("/search <query>", "semantic code search");
    row("/index [embeddings]", "(re)build code graph / search index");
    row("/memory [clear]", "inspect what the agent has learned");
    console.log(dim("  ─ Testing workflow ─"));
    row("/tests", "list discovered test files");
    row("/test [file]", "run tests");
    row("/report [file]", "run tests + write HTML report with screenshots");
    row("/cover <target>", "scaffold a spec for a target");
    row("/ci", "run impact analysis + affected tests");
    row("/doctor", "lint the test suite for anti-patterns");
    row("/trace [stack]", "map a stack trace to tests");
    row("/context", "write project context file");
    row("/sync", "sync the current ticket");
    row("/auth [url]", "capture auth/login state");
    console.log(dim("  ─ Session ─"));
    row("/mode [name]", "cycle or set permissions (ask|auto-save|auto-run|yolo)");
    row("/plan [on|off]", "preview steps/routes before the agent runs");
    row("/verbose", "toggle collapsed vs full tool-call detail");
    row("/save <name>", "snapshot this conversation");
    row("/sessions", "list saved sessions");
    row("/resume [name]", "reload a saved session (or the latest)");
    row("/clear", "clear conversation context");
    row("/help", "show this help");
    row("/exit", "quit");
    console.log(dim("\n  Ctrl+C  stop run → cancel prompt → press again to exit"));
    console.log(dim("  Tab completes /commands  ·  raiken resume [name]\n"));
}
