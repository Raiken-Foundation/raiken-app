import chalk from "chalk";
import { dim } from "../agent-stream";
import { bootstrapProject } from "../bootstrap";
import { CLI_EXIT } from "../errors";

interface IndexOptions {
    /** Legacy flag kept for script compatibility — the vector index was
     *  removed; search now runs on the keyword index the code graph builds. */
    embeddings?: boolean;
    force?: boolean;
}

/**
 * `raiken index` — (re)build the code graph so the agent and impact analysis
 * have current project structure. `raiken search` runs on the keyword index
 * the graph build produces, so no separate embedding step exists anymore.
 */
export async function indexCommand(options: IndexOptions): Promise<void> {
    const projectPath = process.cwd();

    console.log(chalk.cyan("\n  Building code graph…\n"));
    const result = await bootstrapProject(projectPath, { watch: false, verbose: true });

    if (!result.ok) {
        console.log(chalk.red("\n  ✗ Indexing failed — see error above.\n"));
        process.exitCode = CLI_EXIT.RUNTIME_FAILURE;
        return;
    }
    if (result.warnings.length > 0) {
        console.log(
            chalk.yellow(`\n  ⚠ Indexing completed with ${result.warnings.length} warning(s).\n`),
        );
    }
    if (options.embeddings) {
        console.log(
            dim(
                "\n  --embeddings is no longer needed: search runs on the keyword index.\n",
            ),
        );
    }

    console.log(
        dim(
            `\n  Index ready. Try ${chalk.white('raiken search "<query>"')} or ${chalk.white("raiken status")}.\n`,
        ),
    );
}
