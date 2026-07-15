import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { dim, routeDiagnosticsToStderr } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";

interface IndexOptions {
    embeddings?: boolean;
    force?: boolean;
}

/**
 * `raiken index` — (re)build the code graph so the agent and impact analysis
 * have current project structure. With `--embeddings` it also generates the
 * vector index that powers `raiken search`.
 */
export async function indexCommand(options: IndexOptions): Promise<void> {
    const projectPath = process.cwd();

    console.log(chalk.cyan("\n  Building code graph…\n"));
    const result = await bootstrapProject(projectPath, { watch: false, verbose: true });

    if (!result.ok) {
        console.log(chalk.red("\n  ✗ Indexing failed — see error above.\n"));
        process.exitCode = 1;
        return;
    }
    if (result.warnings.length > 0) {
        console.log(
            chalk.yellow(`\n  ⚠ Indexing completed with ${result.warnings.length} warning(s).\n`),
        );
    }

    if (options.embeddings) {
        const caller = appRouter.createCaller({ projectPath });
        const spinner = ora({ text: "Generating embeddings…", spinner: "dots" }).start();
        // The generator logs progress to stdout — route it to stderr so the
        // spinner stays clean and readable.
        const restore = routeDiagnosticsToStderr();
        let res: Awaited<ReturnType<typeof caller.generateEmbeddings>>;
        try {
            res = await caller.generateEmbeddings({ forceRegenerate: options.force === true });
        } finally {
            restore();
        }
        if (res.success) {
            spinner.succeed(
                chalk.green(
                    `Embeddings ready — ${res.filesProcessed}/${res.totalFiles} files, ${res.chunksGenerated} chunks`,
                ),
            );
        } else {
            spinner.fail(chalk.red(`Embeddings failed: ${res.error ?? "unknown error"}`));
        }
    }

    console.log(
        dim(
            `\n  Index ready. Try ${chalk.white('raiken search "<query>"')}, ${chalk.white("raiken status")}, or just ${chalk.white("raiken")}.\n`,
        ),
    );
}
