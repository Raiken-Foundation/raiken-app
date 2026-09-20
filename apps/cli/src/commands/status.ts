import { AgentMemory, createProjectApplication, getProvider, resolveAIConfig } from "@raiken/core";
import chalk from "chalk";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";

/**
 * `raiken status` — a single at-a-glance view of everything Raiken knows about
 * the project: AI config, code graph, embeddings (semantic search), test files,
 * discovered site knowledge, and agent memory. The developer's "am I set up?"
 * command.
 */
export async function statusCommand(options: { json?: boolean }): Promise<void> {
    const projectPath = process.cwd();
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const app = createProjectApplication(projectPath);

    const [graph, embeddings, discSession, discStats] = await Promise.all([
        Promise.resolve(app.indexing.getGraphStats({})).catch(() => null),
        Promise.resolve(app.indexing.getEmbeddingsStats({})).catch(() => null),
        Promise.resolve(app.discovery.getSessionView()).catch(() => null),
        Promise.resolve(app.discovery.getStats()).catch(() => null),
    ]);

    // Count spec files from disk (the same source `raiken test --list` and the
    // dashboard use) — NOT the code graph: the graph isn't built until
    // `raiken index` and doesn't reliably include the test directory, so a
    // graph-based count reported 0 for fully working suites.
    let testCount = 0;
    try {
        const { files } = await app.testing.listTestFiles();
        testCount = files.length;
    } catch {
        /* test directory unreadable */
    }

    let prefCount = 0;
    try {
        const mem = AgentMemory.getInstance(projectPath);
        mem.initialize(false);
        prefCount = Object.keys(mem.getDurablePreferences()).length;
    } catch {
        /* memory unavailable */
    }

    const ai = resolveAIConfig(projectPath);
    const providerLabel = getProvider(ai.provider)?.label ?? ai.provider;

    if (options.json) {
        restore?.();
        process.stdout.write(
            `${JSON.stringify(
                {
                    projectPath,
                    ai: { provider: ai.provider, model: ai.model, hasKey: !!ai.apiKey },
                    codeGraph: graph,
                    embeddings,
                    tests: testCount,
                    memory: { preferences: prefCount },
                    discovery: { session: discSession, stats: discStats },
                },
                null,
                2,
            )}\n`,
        );
        return;
    }

    const row = (label: string, value: string) =>
        console.log(`  ${dim(label.padEnd(16))} ${value}`);

    console.log(accent("\n  Raiken status") + dim(`  ·  ${projectPath}`));

    console.log(accent("\n  AI"));
    row("Provider", providerLabel);
    row("Model", ai.model);
    const providerDef = getProvider(ai.provider);
    row(
        "API key",
        ai.apiKey
            ? chalk.green(`configured (${ai.apiKeySource})`)
            : providerDef.envVars.length === 0
              ? chalk.gray("not required for this provider")
              : chalk.yellow(
                    `missing — set ${providerDef.envVars[0]}, run \`raiken config\`, or configure ` +
                        "it in the dashboard's Settings view",
                ),
    );

    console.log(accent("\n  Code graph"));
    if (graph) {
        row("Files", String(graph.totalFiles));
        row("Functions", String(graph.totalFunctions));
        row("Classes", String(graph.totalClasses));
        row("Lines", graph.totalLines.toLocaleString());
        row("Last scan", new Date(graph.lastScan).toLocaleString());
    } else {
        console.log(dim("  (not built — run `raiken index`)"));
    }

    console.log(accent("\n  Semantic search"));
    if (embeddings && embeddings.totalEmbeddings > 0) {
        row("Vectors", String(embeddings.totalEmbeddings));
        row("Coverage", `${embeddings.embeddingsPerFile} per file`);
    } else {
        console.log(dim("  (no index — run `raiken index --embeddings`)"));
    }

    console.log(accent("\n  Tests"));
    row("Spec files", String(testCount));

    console.log(accent("\n  Site knowledge"));
    if (discSession && discStats) {
        row("Last session", discSession.status);
        row("Pages", String(discStats.pagesCount));
        row("Links", `${discStats.verifiedLinksCount} verified / ${discStats.linksCount} total`);
        row("Blockers", String(discStats.unresolvedBlockersCount));
        console.log(dim("  Details: `raiken knowledge`"));
    } else {
        console.log(dim("  (none — run `raiken discover <url>`)"));
    }

    console.log(accent("\n  Agent memory"));
    row("Preferences", prefCount > 0 ? String(prefCount) : dim("empty"));
    console.log("");
}
