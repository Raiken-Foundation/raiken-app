import { mergeCorrelationContext } from "@raiken/core";
import { splitTestSavePath } from "@raiken/shared";
import chalk from "chalk";
import { accent, dim } from "../../agent-stream";
import { safeCliErrorMessage } from "../../errors";
import { renderBox } from "../box";
import { permissionModeLabel, shouldAutoRun, shouldAutoSave } from "../permissions";
import type { ChatReplContext } from "./types";

export async function saveTestToDisk(
    ctx: ChatReplContext,
    testCode: string,
    suggestedPath: string,
): Promise<string | null> {
    if (!suggestedPath) {
        console.log(chalk.red("  No path — not saved."));
        return null;
    }
    const { fileName, testDir } = splitTestSavePath(suggestedPath);
    try {
        const result = await ctx.app.testing.saveGeneratedTest({
            fileName,
            content: testCode,
            testDir,
        });
        console.log(chalk.green(`  ✓ Saved ${result.filePath}`));
        return result.filePath;
    } catch (err) {
        console.log(chalk.red(`  ✗ Save failed: ${safeCliErrorMessage(err)}`));
        return null;
    }
}

export async function runSavedTest(ctx: ChatReplContext, filePath: string): Promise<void> {
    console.log(dim(`  Running ${filePath}...`));
    try {
        const result = (await ctx.app.testing.runTests({ testFile: filePath })) as {
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
        console.log(chalk.red(`  ✗ Run failed: ${safeCliErrorMessage(err)}`));
    }
}

async function rejectWorkflowAction(
    ctx: ChatReplContext,
    workflowId: string | undefined,
    action: "save" | "run",
): Promise<void> {
    if (!workflowId) return;
    await ctx.app.hitl.continue({
        workflowId,
        action,
        decision: "reject",
    });
}

export async function handleSaveApproval(
    ctx: ChatReplContext,
    hitl: Record<string, unknown>,
): Promise<void> {
    const { state } = ctx;
    const testCode = typeof hitl.testCode === "string" ? hitl.testCode : "";
    let suggestedPath = typeof hitl.suggestedPath === "string" ? hitl.suggestedPath : "";
    const context =
        hitl.context && typeof hitl.context === "object"
            ? (hitl.context as Record<string, unknown>)
            : {};
    const workflowId = typeof context.workflowId === "string" ? context.workflowId : undefined;
    if (workflowId) mergeCorrelationContext({ workflowId });
    if (!testCode) return;

    if (shouldAutoSave(state.permissionMode)) {
        console.log(
            `\n  ${accent("⏺")} ${chalk.bold.white("Auto-saving")}` +
                dim(`  ${suggestedPath || "(no path)"}`) +
                dim(`  ·  ${permissionModeLabel(state.permissionMode)}`),
        );
        const workflowResult = workflowId
            ? await ctx.app.hitl.continue({
                  workflowId,
                  action: "save",
                  decision: "approve",
                  filePath: suggestedPath,
              })
            : null;
        const saved = workflowResult
            ? (workflowResult.savedPath ?? null)
            : await saveTestToDisk(ctx, testCode, suggestedPath);
        if (workflowResult?.savedPath) {
            console.log(chalk.green(`  ✓ Saved ${workflowResult.savedPath}`));
        }
        if (saved && shouldAutoRun(state.permissionMode)) {
            if (workflowResult?.workflow.status === "await_run_approval") {
                const runResult = await ctx.app.hitl.continue({
                    workflowId: workflowId as string,
                    action: "run",
                    decision: "approve",
                });
                console.log(
                    `  ${runResult.run?.success ? chalk.green("✓ passed") : chalk.red("✗ failed")}`,
                );
            } else {
                await runSavedTest(ctx, saved);
            }
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

    const rawAnswer = await ctx.askCancelable(
        `  ${accent("[Y]es · [e]dit path · [r]un · [n]o ›")} `,
    );
    if (rawAnswer === null) {
        await rejectWorkflowAction(ctx, workflowId, "save");
        return;
    }
    const answer = rawAnswer.trim().toLowerCase();
    if (answer === "n" || answer === "no") {
        await rejectWorkflowAction(ctx, workflowId, "save");
        console.log(dim("  Discarded."));
        return;
    }

    const alsoRun = answer === "r" || answer === "run";
    if (answer === "e" || answer === "edit") {
        const p = await ctx.askCancelable("  New path › ");
        if (p === null) {
            await rejectWorkflowAction(ctx, workflowId, "save");
            return;
        }
        if (p.trim()) suggestedPath = p.trim();
    }

    if (workflowId) {
        const result = await ctx.app.hitl.continue({
            workflowId,
            action: "save",
            decision: "approve",
            filePath: suggestedPath,
        });
        const saved = result.savedPath;
        if (saved && alsoRun && result.workflow.status === "await_run_approval") {
            await ctx.app.hitl.continue({
                workflowId,
                action: "run",
                decision: "approve",
            });
        } else if (saved && alsoRun) {
            await runSavedTest(ctx, saved);
        }
        return;
    }
    const saved = await saveTestToDisk(ctx, testCode, suggestedPath);
    if (saved && alsoRun) await runSavedTest(ctx, saved);
}

export async function handleRunApproval(
    ctx: ChatReplContext,
    hitl: Record<string, unknown>,
): Promise<void> {
    const { state } = ctx;
    const testFile = typeof hitl.testFile === "string" ? hitl.testFile : "";
    const testName = typeof hitl.testName === "string" ? hitl.testName : testFile;
    const context =
        hitl.context && typeof hitl.context === "object"
            ? (hitl.context as Record<string, unknown>)
            : {};
    const workflowId = typeof context.workflowId === "string" ? context.workflowId : undefined;
    if (workflowId) mergeCorrelationContext({ workflowId });
    if (!testFile) return;

    if (shouldAutoRun(state.permissionMode)) {
        console.log(
            `\n  ${accent("⏺")} ${chalk.bold.white("Auto-running")}` +
                dim(`  ${testFile}`) +
                dim(`  ·  ${permissionModeLabel(state.permissionMode)}`),
        );
        if (workflowId) {
            const result = await ctx.app.hitl.continue({
                workflowId,
                action: "run",
                decision: "approve",
            });
            console.log(
                `  ${result.run?.success ? chalk.green("✓ passed") : chalk.red("✗ failed")}`,
            );
        } else {
            await runSavedTest(ctx, testFile);
        }
        return;
    }

    console.log("");
    console.log(renderBox([`${accent("Run test?")}  ${dim(testFile)}`, "", dim(testName)]));

    const rawAnswer = await ctx.askCancelable(`  ${accent("[Y]es · [n]o ›")} `);
    if (rawAnswer === null) {
        await rejectWorkflowAction(ctx, workflowId, "run");
        return;
    }
    const answer = rawAnswer.trim().toLowerCase();
    if (answer === "n" || answer === "no") {
        await rejectWorkflowAction(ctx, workflowId, "run");
        console.log(dim("  Skipped."));
        return;
    }
    if (workflowId) {
        await ctx.app.hitl.continue({
            workflowId,
            action: "run",
            decision: "approve",
        });
        return;
    }
    await runSavedTest(ctx, testFile);
}
