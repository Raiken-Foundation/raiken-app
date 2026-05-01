/**
 * `raiken context` — emits a Markdown snapshot of the project's testing
 * state for IDE-side AI agents (Cursor, Claude, Copilot) to consume.
 */

import { writeProjectContext } from "@raiken/core";
import chalk from "chalk";

interface ContextCommandOptions {
    output?: string;
    /** Cap on rows printed in each section. */
    maxRows?: string;
    /** Suppress the diff/impact section. */
    noImpact?: boolean;
    json?: boolean;
}

export async function contextCommand(options: ContextCommandOptions): Promise<void> {
    const projectPath = process.cwd();
    const maxRowsPerSection = options.maxRows ? Number(options.maxRows) : undefined;

    if (!options.json) {
        console.log(chalk.cyan("\n📝 raiken context — building project snapshot…\n"));
    }

    const result = await writeProjectContext({
        projectPath,
        outputPath: options.output,
        maxRowsPerSection,
        includeImpact: options.noImpact !== true,
    });

    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }

    console.log(chalk.green(`✅ Wrote ${result.outputPath}`));
    console.log(chalk.dim(`   ${formatBytes(result.bytesWritten)}`));
    const enabled = Object.entries(result.sections)
        .filter(([, on]) => on)
        .map(([k]) => k);
    console.log(chalk.dim(`   sections: ${enabled.join(", ") || "(none)"}`));
    console.log();
    console.log(
        chalk.dim(
            "Tip: keep this file in your editor's context window when asking the AI " +
                "about tests, coverage, or recent failures.",
        ),
    );
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}
