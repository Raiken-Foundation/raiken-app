import { createProjectApplication } from "@raiken/core";
import chalk from "chalk";
import ora from "ora";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";
import { CLI_EXIT } from "../errors";
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
        cliExit(CLI_EXIT.USAGE);
    }

    let chunkTypes: ChunkType[] | undefined;
    if (options.type) {
        if (!CHUNK_TYPES.includes(options.type as ChunkType)) {
            console.error(chalk.red(`  invalid --type. one of: ${CHUNK_TYPES.join(", ")}`));
            cliExit(CLI_EXIT.USAGE);
        }
        chunkTypes = [options.type as ChunkType];
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
    let res = await app.indexing.searchCode({ query, limit, chunkTypes });

    // Auto-heal the index on first use — human mode only (generation logs would
    // pollute --json stdout, so scripts get the explicit "run index" message).
    // Embeddings come from a local model, so this needs no API key — but the
    // first run downloads model weights, hence the spinner copy.
    if (
        !options.json &&
        res.results.length === 0 &&
        /no (search index|embeddings)/i.test(res.message ?? "")
    ) {
        if (spinner) spinner.text = "Building search index (first run only)…";
        const genRestore = routeDiagnosticsToStderr();
        try {
            await app.indexing.generateEmbeddings({ forceRegenerate: false });
            res = await app.indexing.searchCode({ query, limit, chunkTypes });
        } catch {
            // Model download/generation failed — keep the original "no index"
            // result so the user still gets the explicit remediation message.
        } finally {
            genRestore();
        }
    }
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
        if (res.message) {
            // The backend message usually names the fix itself; only add the
            // pointer when it doesn't.
            const suffix = res.message.includes("raiken index")
                ? ""
                : " → try `raiken index --embeddings`";
            console.log(dim(`  ${res.message}${suffix}`));
        }
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
