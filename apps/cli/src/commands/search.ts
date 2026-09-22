import { createProjectApplication } from "@raiken/core";
import chalk from "chalk";
import ora from "ora";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";
import { CLI_EXIT } from "../errors";
import { cliExit } from "../cli/exit";

interface SearchOptions {
    limit?: string;
    type?: string;
    json?: boolean;
}

/**
 * `raiken search <query>` — keyword search over the code-graph index (paths,
 * symbols, and AST text). Replaces the removed embeddings/vector search; no
 * model download and no separate build step — the keyword index exists as
 * soon as the code graph does (`raiken index`).
 */
export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
    const projectPath = process.cwd();
    if (!query || !query.trim()) {
        console.error(chalk.red('  usage: raiken search "<query>"'));
        cliExit(CLI_EXIT.USAGE);
    }

    let limit = 10;
    if (options.limit !== undefined) {
        const parsed = Number(options.limit);
        if (!Number.isInteger(parsed) || parsed < 1) {
            console.error(
                chalk.red(`  --limit must be a positive integer; got "${options.limit}".`),
            );
            cliExit(CLI_EXIT.USAGE);
        }
        limit = parsed;
    }

    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const app = createProjectApplication(projectPath);

    const spinner = options.json ? null : ora({ text: "Searching…", spinner: "dots" }).start();
    const res = await app.indexing.searchCode({ query, limit });
    spinner?.stop();

    if (options.json) {
        restore?.();
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        return;
    }

    if (res.error) {
        console.error(chalk.red(`  search failed: ${res.error}`));
        cliExit(CLI_EXIT.RUNTIME_FAILURE);
    }
    if (res.results.length === 0) {
        console.log(dim(`\n  No matches for "${query}".`));
        console.log(dim("  → try `raiken index` to (re)build the code graph"));
        console.log("");
        return;
    }

    console.log(accent(`\n  ${res.results.length} matches`) + dim(`  for "${query}"`));
    for (const r of res.results) {
        console.log(
            `\n  ${chalk.green(`${r.relevanceScore}%`)} ${chalk.white(r.chunkName)} ${dim(`(${r.chunkType})`)}`,
        );
        console.log(`  ${dim(r.filePath)}`);
        const preview = r.chunkText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 3);
        for (const line of preview) console.log(`  ${dim("│")} ${dim(line.slice(0, 96))}`);
    }
    console.log("");
}
