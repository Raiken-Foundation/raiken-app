import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";
import { cliExit } from "../repl/exit";

interface SearchOptions {
    limit?: string;
    type?: string;
    json?: boolean;
}

const CHUNK_TYPES = ["function", "class", "file", "type"] as const;
type ChunkType = (typeof CHUNK_TYPES)[number];

/**
 * `raiken search <query>` — semantic (embeddings) search over the codebase.
 * Finds relevant functions/classes/files by meaning, not just text. On first
 * use it builds the embeddings index automatically (human mode only, so JSON
 * output stays script-clean).
 */
export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
    const projectPath = process.cwd();
    if (!query || !query.trim()) {
        console.error(chalk.red('  usage: raiken search "<query>"'));
        cliExit(1);
    }

    let chunkTypes: ChunkType[] | undefined;
    if (options.type) {
        if (!CHUNK_TYPES.includes(options.type as ChunkType)) {
            console.error(chalk.red(`  invalid --type. one of: ${CHUNK_TYPES.join(", ")}`));
            cliExit(1);
        }
        chunkTypes = [options.type as ChunkType];
    }
    const limit = options.limit ? Math.max(1, Number(options.limit) || 10) : 10;

    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const caller = appRouter.createCaller({ projectPath });

    const spinner = options.json ? null : ora({ text: "Searching…", spinner: "dots" }).start();
    let res = await caller.searchCode({ query, limit, chunkTypes });

    // Auto-heal the index on first use — human mode only (generation logs would
    // pollute --json stdout, so scripts get the explicit "run index" message).
    if (!options.json && res.results.length === 0 && res.message?.includes("No embeddings")) {
        if (spinner) spinner.text = "Building search index (first run only)…";
        const genRestore = routeDiagnosticsToStderr();
        try {
            await caller.generateEmbeddings({ forceRegenerate: false });
        } finally {
            genRestore();
        }
        res = await caller.searchCode({ query, limit, chunkTypes });
    }
    spinner?.stop();

    if (options.json) {
        restore?.();
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        return;
    }

    if (res.error) {
        console.error(chalk.red(`  search failed: ${res.error}`));
        cliExit(1);
    }
    if (res.results.length === 0) {
        console.log(dim(`\n  No matches for "${query}".`));
        if (res.message) console.log(dim(`  ${res.message} → try \`raiken index --embeddings\``));
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
