/**
 * `raiken context` — emits a Markdown snapshot of the project's testing
 * state for IDE-side AI agents (Cursor, Claude, Copilot) to consume.
 */

import { formatBytes, writeProjectContext } from "@raiken/core";
import chalk from "chalk";

interface ContextCommandOptions {
    output?: string;
    /** Cap on rows printed in each section. */
    maxRows?: string;
    /**
     * Whether to include the diff/impact section. Commander maps the `--no-impact`
     * flag to `impact: false` (default true), so we read this key — not `noImpact`.
     */
    impact?: boolean;
    json?: boolean;
}

export async function contextCommand(options: ContextCommandOptions): Promise<void> {
    const projectPath = process.cwd();
    // Only accept a positive integer; a non-numeric `--max-rows` would otherwise
    // become NaN and silently disable/short the section caps downstream.
    const parsedMaxRows = options.maxRows ? Number(options.maxRows) : undefined;
    const maxRowsPerSection =
        parsedMaxRows !== undefined && Number.isInteger(parsedMaxRows) && parsedMaxRows > 0
            ? parsedMaxRows
            : undefined;

    if (!options.json) {
        console.log(chalk.cyan("\nraiken context — building project snapshot…\n"));
    }

    const result = await writeProjectContext({
        projectPath,
        outputPath: options.output,
        maxRowsPerSection,
        includeImpact: options.impact !== false,
    });

    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }

    console.log(chalk.green(`✓ Wrote ${result.outputPath}`));
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
