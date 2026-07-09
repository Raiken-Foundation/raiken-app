/**
 * `raiken hooks` — install / uninstall git hooks that run raiken locally.
 *
 * The actual install/uninstall/inspection logic lives in `@raiken/shared/lib/git-hooks`
 * so the dashboard can call into it via tRPC. This file is just a thin CLI
 * wrapper that maps Commander options to that library and pretty-prints the result.
 */

import * as path from "node:path";
import { getHookStatus, type HookType, installHook, uninstallHook } from "@raiken/shared";
import chalk from "chalk";

interface HooksInstallOptions {
    type?: string;
    skipRun?: boolean;
    husky?: boolean;
}

interface HooksUninstallOptions {
    type?: string;
}

function coerceType(value: string | undefined): HookType | undefined {
    if (!value) return undefined;
    const v = value.toLowerCase();
    if (v === "pre-commit" || v === "pre-push") return v;
    throw new Error(`Unknown hook type "${value}". Use pre-commit or pre-push.`);
}

export async function hooksInstallCommand(options: HooksInstallOptions): Promise<void> {
    const result = installHook({
        projectPath: process.cwd(),
        type: coerceType(options.type),
        skipRun: options.skipRun,
        husky: options.husky === true,
    });

    console.log(chalk.green(`✓ Installed ${result.type} hook → ${result.relativePath}`));
    console.log(chalk.dim(`   ${result.description}`));
    if (result.kind === "husky") {
        console.log(chalk.dim("   Husky-managed: hooks live under .husky/."));
    }
}

export async function hooksUninstallCommand(options: HooksUninstallOptions): Promise<void> {
    const result = uninstallHook({
        projectPath: process.cwd(),
        type: coerceType(options.type),
    });

    if (result.affected.length === 0) {
        console.log(chalk.yellow(`No raiken-managed ${result.type} hook found.`));
        return;
    }

    for (const entry of result.affected) {
        if (entry.action === "deleted") {
            console.log(chalk.green(`✓ Removed ${entry.relativePath}`));
        } else {
            console.log(chalk.green(`✓ Stripped raiken block from ${entry.relativePath}`));
        }
    }
}

export async function hooksStatusCommand(): Promise<void> {
    const projectPath = process.cwd();
    const entries = getHookStatus(projectPath);

    if (entries.length === 0) {
        console.log(chalk.dim("No git hooks installed in this repo."));
        console.log(chalk.dim("Run `raiken hooks install --type pre-commit` to add one."));
        return;
    }

    console.log(chalk.bold("Git hooks:"));
    for (const c of entries) {
        const flag = c.managed ? chalk.green("raiken-managed") : chalk.dim("(unmanaged)");
        const rel = path.relative(projectPath, path.resolve(projectPath, c.relativePath));
        console.log(`  ${c.type.padEnd(11)} ${rel.padEnd(40)} ${flag}`);
    }
}
