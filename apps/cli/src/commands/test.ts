import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import { dim, routeDiagnosticsToStderr } from "../agent-stream";
import { cliExit } from "../repl/exit";

interface TestOptions {
    json?: boolean;
}

interface RunTestsResult {
    success: boolean;
    stderr?: string;
    results?: {
        stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
    } | null;
}

/**
 * `raiken test [file]` — run the Playwright suite (or a single spec) and report
 * a compact pass/fail summary. Exit code reflects the outcome so it drops into
 * scripts and pre-push hooks. Mirrors the REPL `/test` command.
 */
export async function testCommand(file: string | undefined, options: TestOptions): Promise<void> {
    const projectPath = process.cwd();
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const caller = appRouter.createCaller({ projectPath });

    if (!options.json) {
        process.stderr.write(dim(`\n  Running tests${file ? ` for ${file}` : ""}…\n`));
    }

    const result = (await caller.runTests(file ? { testFile: file } : {})) as RunTestsResult;
    const stats = result.results?.stats;
    const passed = stats?.expected ?? 0;
    const failed = stats?.unexpected ?? 0;
    const skipped = stats?.skipped ?? 0;

    if (options.json) {
        restore?.();
        process.stdout.write(
            `${JSON.stringify({ success: result.success, passed, failed, skipped }, null, 2)}\n`,
        );
    } else {
        const badge = result.success ? chalk.green("✓ passed") : chalk.red("✗ failed");
        console.log(
            `  ${badge}${dim(`  (${passed} passed, ${failed} failed, ${skipped} skipped)`)}`,
        );
        if (!result.success && result.stderr) {
            console.log(dim(result.stderr.split("\n").slice(0, 8).join("\n")));
        }
        console.log("");
    }

    cliExit(result.success ? 0 : 1);
}
