import fs from "node:fs";
import { BrowserSession, formatDOMContext } from "@raiken/core";
import chalk from "chalk";
import { dim } from "../../../../agent-stream";
import { renderSnapshot, splitAssign } from "../../browser-helpers";
import type { SlashHandler } from "../registry";

export const handleGoto: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    if (!rawArg) return void console.log(chalk.red("  usage: /goto <url>"));
    const session = await ctx.ensureBrowser();
    const dom = await session.navigate(rawArg);
    renderSnapshot(dom);
};

export const handleClick: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    if (!rawArg) return void console.log(chalk.red("  usage: /click <selector>"));
    const session = await ctx.ensureBrowser();
    await session.click(rawArg);
    console.log(chalk.green(`  ✓ clicked ${dim(rawArg)}`));
};

export const handleFill: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const [sel, val] = splitAssign(rawArg);
    if (!sel || val === undefined)
        return void console.log(chalk.red("  usage: /fill <selector> = <value>"));
    const session = await ctx.ensureBrowser();
    await session.fill(sel, val);
    console.log(chalk.green(`  ✓ filled ${dim(sel)}`));
};

export const handleType: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const [sel, val] = splitAssign(rawArg);
    if (!sel || val === undefined)
        return void console.log(chalk.red("  usage: /type <selector> = <text>"));
    const session = await ctx.ensureBrowser();
    await session.type(sel, val);
    console.log(chalk.green(`  ✓ typed into ${dim(sel)}`));
};

export const handlePress: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    if (!rawArg) return void console.log(chalk.red("  usage: /press <key>"));
    const session = await ctx.ensureBrowser();
    await session.press(rawArg);
    console.log(chalk.green(`  ✓ pressed ${dim(rawArg)}`));
};

export const handleSnapshot: SlashHandler = async (ctx) => {
    const session = await ctx.ensureBrowser();
    const dom = await session.captureCurrentPage();
    console.log(formatDOMContext(dom));
};

export const handleUrl: SlashHandler = async (ctx) => {
    const session = BrowserSession.getInstance(ctx.projectPath);
    console.log(session.isActive() ? session.getCurrentUrl() : dim("  (no active page)"));
};

export const handleBack: SlashHandler = async (ctx) => {
    const session = await ctx.ensureBrowser();
    const dom = await session.goBack();
    if (dom) renderSnapshot(dom);
    else console.log(dim("  (no history)"));
};

export const handleReload: SlashHandler = async (ctx) => {
    const session = await ctx.ensureBrowser();
    renderSnapshot(await session.reload());
};

export const handleScreenshot: SlashHandler = async (ctx) => {
    const session = await ctx.ensureBrowser();
    const buf = await session.screenshot();
    const file = `raiken-shot-${Date.now()}.png`;
    fs.writeFileSync(file, buf);
    console.log(chalk.green(`  ✓ saved ${file}`));
};

export const browserSlashHandlers: Record<string, SlashHandler> = {
    goto: handleGoto,
    click: handleClick,
    fill: handleFill,
    type: handleType,
    press: handlePress,
    snapshot: handleSnapshot,
    url: handleUrl,
    back: handleBack,
    reload: handleReload,
    screenshot: handleScreenshot,
};
