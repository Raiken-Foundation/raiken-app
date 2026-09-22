import { createProjectApplication, resolveAuthStorageStatePath } from "@raiken/core";
import chalk from "chalk";
import { dim } from "../agent-stream";
import { CLI_EXIT } from "../errors";
import { cliExit } from "../cli/exit";
import { safeCliErrorMessage } from "../errors";

interface ContractOptions {
    json?: boolean;
    args?: string[];
    format?: string;
    every?: number;
    webhook?: string;
    accept?: number;
    reject?: number;
    undo?: number;
    file?: string;
    text?: string;
    ticket?: string;
    yes?: boolean;
    all?: boolean;
    base?: string;
    out?: string;
    baseUrl?: string;
}

/**
 * `raiken contract <subcommand>` — the two-sided behavior contract.
 *
 *   show        render the contract (facts, requirements, coverage)
 *   coverage    requirement coverage report only
 *   capture     live empty-submit probing mints validation facts
 *   mint        mint facts from what discovery already recorded
 *   import      import intent from an AC file (--file) or ticket (--ticket)
 *   export      write .raiken/contract.md + contract.json
 *   diff        delta against the last export
 *   verify      re-observe facts against the live app (diff-scoped; exit 1 on violations)
 *   materialize emit disposable Playwright specs from facts
 *   routes      routes extracted from source (Next.js app-dir, React Router)
 *   snapshot    visit known routes; record what loads
 *   explore     LLM-driven exploration of uncovered requirements
 *   record      record GET traffic for hermetic materialization mocks
 *   history     evidence ledger: mint/verify/violate timeline per fact
 *   review      accept or reject behavior changes found by verify
 *   search      find facts/requirements by keyword
 *   watch       verify on a schedule; webhook alerts on new regressions
 */
export async function contractCommand(
    subcommand: string | undefined,
    options: ContractOptions,
): Promise<void> {
    const projectPath = process.cwd();
    const app = createProjectApplication(projectPath);
    const contract = app.contract;

    switch (subcommand ?? "show") {
        case "show": {
            const view = contract.view();
            if (options.json) {
                process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
                return;
            }
            console.log(chalk.cyan("\n  Behavior Contract\n"));
            console.log(`  Observed facts:   ${view.observed.length}`);
            const byStatus = view.observed.reduce<Record<string, number>>((acc, f) => {
                acc[f.status] = (acc[f.status] ?? 0) + 1;
                return acc;
            }, {});
            console.log(
                `  Fact status:      ${Object.entries(byStatus)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(" · ") || "—"}`,
            );
            if (view.observed.length > 0) {
                const confidences = view.observed.map((f) => f.confidence);
                const min = Math.min(...confidences);
                const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
                const lowest = view.observed.filter((f) => f.confidence === min)[0];
                console.log(
                    `  Fact confidence:  avg ${Math.round(avg * 100)}% · lowest ${Math.round(
                        min * 100,
                    )}%${lowest ? ` (${lowest.route}: ${lowest.action.slice(0, 48)})` : ""}`,
                );
            }
            console.log(`  Requirements:     ${view.intent.length}`);
            if (view.coverage) {
                const c = view.coverage;
                console.log(
                    `  Coverage:         ${chalk.green(`${c.covered} covered`)} · ${chalk.yellow(
                        `${c.uncovered} uncovered`,
                    )} · ${chalk.red(`${c.violated} violated`)}`,
                );
                for (const entry of c.entries.filter((e) => e.verdict !== "covered").slice(0, 8)) {
                    const flag = entry.intent.neverRegress ? chalk.red(" 🔒never-regress") : "";
                    console.log(
                        `    ${entry.verdict === "violated" ? chalk.red("[violated]") : chalk.yellow("[uncovered]")} ${entry.intent.requirementText.slice(0, 90)}${flag}`,
                    );
                }
            }
            if (view.observed.length === 0 && view.intent.length === 0) {
                console.log("");
                console.log(dim("  The contract is empty. Build the two sides:"));
                console.log(dim("    1. raiken discover <url>          record the app's pages/forms"));
                console.log(dim("    2. raiken contract capture <url>  observe it — mints facts with evidence"));
                console.log(
                    dim("    3. raiken contract import --file requirements.md   add ticket intent"),
                );
                console.log(dim("    4. raiken contract verify         re-observe on every change (exit 1 on regression)"));
            }
            console.log("");
            return;
        }

        case "coverage": {
            const report = contract.coverage();
            if (options.json) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
                return;
            }
            console.log(chalk.cyan("\n  Requirement Coverage\n"));
            console.log(
                `  ${report.covered}/${report.total} covered · ${report.uncovered} uncovered · ${report.violated} violated`,
            );
            if (report.total === 0) {
                console.log(
                    dim(
                        "\n  No requirements imported yet — `raiken contract import --file <ac.md>` (or --ticket <id>).",
                    ),
                );
                console.log("");
                return;
            }
            if (report.neverRegressUncovered > 0) {
                console.log(
                    chalk.red(`  ⚠ ${report.neverRegressUncovered} never-regress requirement(s) uncovered`),
                );
            }
            for (const entry of report.entries) {
                const mark =
                    entry.verdict === "covered"
                        ? chalk.green("✓")
                        : entry.verdict === "violated"
                          ? chalk.red("✗")
                          : chalk.yellow("○");
                const origin = entry.intent.ticketId ? ` [#${entry.intent.ticketId}]` : "";
                console.log(`  ${mark} ${entry.intent.requirementText.slice(0, 96)}${origin}`);
                if (entry.matches.length > 0) {
                    console.log(
                        dim(`      → ${entry.matches[0].fact.action} ${entry.matches[0].fact.expectedObservable} (${Math.round(entry.matches[0].score * 100)}%)`),
                    );
                }
            }
            console.log("");
            return;
        }

        case "capture": {
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            console.log(chalk.cyan("\n  Capturing form states (empty-submit probing)…\n"));
            const result = await contract.capture({ storageStatePath });
            console.log(
                chalk.green(
                    `  ✓ ${result.factsMinted} new fact(s), ${result.factsRefreshed} refreshed across ${result.pagesProbed} page(s)`,
                ),
            );
            for (const d of result.details.slice(0, 10)) {
                console.log(dim(`    ${d.route} — ${d.action} → ${d.observable}`));
            }
            console.log("");
            return;
        }

        case "mint": {
            const result = contract.mintFromDiscovery();
            console.log(
                chalk.green(
                    `\n  ✓ ${result.minted} fact(s) minted from site knowledge (${result.refreshed} refreshed)\n`,
                ),
            );
            return;
        }

        case "import": {
            let result: { imported: number; skipped: number; requirements: number };
            if (options.ticket) {
                const { loadIntegrationsConfig, resolveTicketProviderForConfig } = await import(
                    "@raiken/core"
                );
                const config = loadIntegrationsConfig(projectPath);
                const provider = resolveTicketProviderForConfig(config, projectPath);
                if (!provider) {
                    console.error(
                        chalk.red(
                            `\n✗ Ticket provider not configured. Set integrations.provider in raiken.config.json.\n`,
                        ),
                    );
                    cliExit(CLI_EXIT.CONFIG_AUTH);
                }
                const ticket = await provider.getTicket(options.ticket);
                result = contract.importFromTicket({
                    id: ticket.id,
                    provider: ticket.provider,
                    title: ticket.title,
                    body: ticket.description,
                    severity: ticket.status,
                    url: ticket.url,
                });
            } else if (options.file || options.text) {
                result = contract.importFromFile({ filePath: options.file, text: options.text });
            } else {
                console.error(chalk.red("\n  Provide --file <path>, --text <requirements>, or --ticket <id>.\n"));
                cliExit(CLI_EXIT.USAGE);
            }
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                return;
            }
            console.log(
                chalk.green(
                    `\n  ✓ ${result.imported} requirement(s) imported (${result.skipped} duplicate skipped, ${result.requirements} parsed)\n`,
                ),
            );
            return;
        }

        case "export": {
            const paths = contract.export();
            console.log(chalk.green(`\n  ✓ ${paths.markdownPath}`));
            console.log(chalk.green(`  ✓ ${paths.jsonPath}\n`));
            return;
        }

        case "diff": {
            const d = contract.diff();
            if (options.json) {
                process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
                return;
            }
            if (!d.hasBaseline) {
                console.log(dim("\n  No previous export — run `raiken contract export` to set the baseline.\n"));
                return;
            }
            const sections: Array<[string, string[]]> = [
                ["Added facts", d.addedFacts],
                ["Removed facts", d.removedFacts],
                ["Added requirements", d.addedIntent],
                ["Removed requirements", d.removedIntent],
            ];
            let any = false;
            console.log(chalk.cyan("\n  Contract diff (vs last export)\n"));
            for (const [label, items] of sections) {
                if (items.length === 0) continue;
                any = true;
                console.log(`  ${label}:`);
                for (const item of items.slice(0, 10)) console.log(`    ${chalk.green("+")} ${item}`);
            }
            for (const change of d.statusChanged.slice(0, 10)) {
                any = true;
                console.log(`    ${chalk.yellow("~")} ${change.key} [${change.from} → ${change.to}]`);
            }
            for (const change of d.coverageChanged.slice(0, 10)) {
                any = true;
                console.log(
                    `    ${chalk.yellow("~")} coverage: ${change.key} [${change.from} → ${change.to}]`,
                );
            }
            if (!any) console.log(dim("  No changes."));
            console.log("");
            return;
        }

        case "verify": {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            let changedFiles: string[] | undefined;
            if (!(options as Record<string, unknown>)["all"]) {
                const { getChangedFiles } = await import("../git-changed");
                changedFiles = await getChangedFiles(
                    projectPath,
                    String((options as Record<string, unknown>)["base"] ?? "HEAD"),
                );
            }
            console.log(chalk.cyan("\n  Verifying contract facts…\n"));
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            const result = await contract.verify({
                changedFiles,
                verifyAll: Boolean((options as Record<string, unknown>)["all"]),
                storageStatePath,
            });
            const violations = contract.violationsReport(result.verdicts);
            const verifiedCount = result.verdicts.filter((v) => v.verdict === "verified").length;
            const unverifiedCount = result.verdicts.filter((v) => v.verdict === "unverified").length;

            if ((options as Record<string, unknown>)["json"]) {
                process.stdout.write(
                    `${JSON.stringify(
                        { ...result, verifiedCount, unverifiedCount, violations },
                        null,
                        2,
                    )}\n`,
                );
                cliExit(violations.length > 0 ? CLI_EXIT.RUNTIME_FAILURE : 0);
            }

            console.log(
                `  ${verifiedCount} verified · ${violations.length} violated · ${unverifiedCount} unverified  (${result.scoped}/${result.total} facts in scope)`,
            );
            const format = String((options as Record<string, unknown>)["format"] ?? "");
            for (const v of violations) {
                if (format === "github") {
                    // GitHub Actions annotation — surfaces inline on the PR.
                    console.log(`::error title=contract violation::${v.line}`);
                } else {
                    console.log(chalk.red(`  ✗ ${v.line}`));
                }
            }
            console.log("");
            cliExit(violations.length > 0 ? CLI_EXIT.RUNTIME_FAILURE : 0);
        }

        case "materialize": {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            const outDir = String((options as Record<string, unknown>)["out"] ?? ".raiken/materialized");
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            const result = contract.materialize({ outDir, storageStatePath });
            console.log(
                chalk.green(
                    `\n  ✓ ${result.testCount} spec(s) materialized → ${result.specPath}${
                        result.skipped ? ` (${result.skipped} fact(s) not playable yet)` : ""
                    }\n`,
                ),
            );
            return;
        }

        case "routes": {
            const sourceRoutes = contract.sourceRoutes();
            if ((options as Record<string, unknown>)["json"]) {
                process.stdout.write(`${JSON.stringify(sourceRoutes, null, 2)}\n`);
                return;
            }
            console.log(chalk.cyan(`\n  Source routes (${sourceRoutes.length})\n`));
            for (const route of sourceRoutes.slice(0, 20)) {
                console.log(
                    `  ${route.path} ${route.dynamic ? chalk.yellow("(dynamic)") : ""} ${dim(`— ${route.sourceFile} [${route.source}]`)}`,
                );
            }
            console.log("");
            return;
        }

        case "snapshot": {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            console.log(chalk.cyan("\n  Snapshotting known routes…\n"));
            const result = await contract.snapshotRoutes({ storageStatePath });
            console.log(
                chalk.green(
                    `  ✓ ${result.captured.length}/${result.total} routes captured (${Math.round(result.coverage * 100)}% checklist coverage, ${result.sources} from source)`,
                ),
            );
            for (const f of result.failed.slice(0, 5)) {
                console.log(chalk.yellow(`    ✗ ${f.route} — ${f.reason.slice(0, 80)}`));
            }
            console.log("");
            return;
        }

        case "explore": {
            const { resolveAIConfig, resolveAuthStorageStatePath } = await import("@raiken/core");
            const ai = resolveAIConfig(projectPath);
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            console.log(chalk.cyan("\n  Exploring uncovered requirements…\n"));
            const { outcomes, coverage } = await contract.explore({ ai, storageStatePath });
            if ((options as Record<string, unknown>)["json"]) {
                process.stdout.write(`${JSON.stringify({ outcomes, coverage }, null, 2)}\n`);
                return;
            }
            for (const outcome of outcomes) {
                const mark = outcome.covered ? chalk.green("✓ covered") : chalk.yellow("○ still uncovered");
                console.log(
                    `  ${mark} ${outcome.requirementText.slice(0, 90)} (${outcome.executedSteps} step(s), ${outcome.factsMinted} fact(s) minted)`,
                );
                if (outcome.failure) console.log(dim(`    → ${outcome.failure.slice(0, 100)}`));
            }
            console.log(
                `\n  Coverage: ${coverage.covered}/${coverage.total} covered · ${coverage.uncovered} uncovered`,
            );
            console.log("");
            return;
        }

        case "record": {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            console.log(chalk.cyan("\n  Recording API reads across known routes…\n"));
            const result = await contract.record({ storageStatePath });
            console.log(
                chalk.green(`  ✓ ${result.recorded} GET endpoint(s) recorded → ${result.filePath}\n`),
            );
            console.log(dim("  Materialized specs will replay these as page.route() mocks."));
            console.log("");
            return;
        }

        case "search": {
            const args = (options as Record<string, unknown>)["args"] as string[] | undefined;
            const query = (args ?? []).join(" ").trim();
            if (!query) {
                console.error(chalk.red("\n  Provide a query: raiken contract search checkout\n"));
                cliExit(CLI_EXIT.USAGE);
            }
            const { facts, intents } = contract.searchContract(query);
            if ((options as Record<string, unknown>)["json"]) {
                process.stdout.write(`${JSON.stringify({ query, facts, intents }, null, 2)}\n`);
                return;
            }
            console.log(chalk.cyan(`\n  Contract search: "${query}"\n`));
            if (facts.length === 0 && intents.length === 0) {
                console.log(dim("  No facts or requirements match.\n"));
                return;
            }
            if (facts.length > 0) {
                console.log(chalk.bold(`  Observed facts (${facts.length})`));
                for (const f of facts.slice(0, 10)) {
                    console.log(
                        `  ${chalk.green(f.status === "verified" ? "✓" : f.status === "violated" ? "✗" : "○")} ${f.route} — ${f.action} → ${f.expectedObservable.slice(0, 60)}`,
                    );
                }
            }
            if (intents.length > 0) {
                console.log(chalk.bold(`\n  Requirements (${intents.length})`));
                for (const i of intents.slice(0, 10)) {
                    console.log(
                        `  ${i.status === "covered" ? chalk.green("✓") : i.status === "violated" ? chalk.red("✗") : chalk.yellow("○")} ${i.requirementText.slice(0, 84)}${i.ticketId ? dim(` [#${i.ticketId}]`) : ""}`,
                    );
                }
            }
            console.log("");
            return;
        }

        case "history": {
            const opts = options as Record<string, unknown>;
            const key = (opts["file"] ?? opts["text"]) as string | undefined;
            const events = contract.factHistory(key);
            if ((options as Record<string, unknown>)["json"]) {
                process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
                return;
            }
            if (events.length === 0) {
                console.log(
                    key
                        ? dim(`\n  No events recorded for ${key} yet — run \`raiken contract verify\`.\n`)
                        : dim("\n  Evidence ledger is empty — verify or capture to start it.\n"),
                );
                return;
            }
            console.log(chalk.cyan(`\n  Evidence ledger${key ? ` — ${key}` : ""}\n`));
            for (const e of events.slice(0, 40)) {
                const mark =
                    e.eventType === "verified"
                        ? chalk.green("✓ verified")
                        : e.eventType === "violated"
                          ? chalk.red("✗ violated")
                          : e.eventType === "minted"
                            ? chalk.magenta("+ minted")
                            : chalk.yellow("○ unverified");
                const when = new Date(e.occurredAt).toISOString().replace("T", " ").slice(0, 19);
                console.log(`  ${dim(when)}  ${mark}  ${e.detail ?? e.factKey.slice(0, 12)}${key ? "" : dim(`  (${e.factKey.slice(0, 8)})`)}`);
            }
            console.log("");
            return;
        }

        case "review": {
            const opts = options as Record<string, unknown>;
            const acceptId = opts["accept"] as number | undefined;
            const rejectId = opts["reject"] as number | undefined;
            const undoId = opts["undo"] as number | undefined;
            if (undoId != null) {
                const ok = contract.restoreReview(Number(undoId));
                console.log(
                    ok
                        ? chalk.green(`\n  \u2713 review #${undoId} undone \u2014 fact restored as unverified; it re-verifies next cycle\n`)
                        : chalk.red("\n  \u2717 only an accepted review with a snapshot can be undone\n"),
                );
                return;
            }
            if (acceptId != null || rejectId != null) {
                const accept = acceptId != null;
                const ok = contract.resolveReview(Number(accept ? acceptId : rejectId), accept);
                console.log(
                    ok
                        ? chalk.green(
                              `\n  ✓ review #${accept ? acceptId : rejectId} ${accept ? "accepted — old fact retired; the new behavior is the contract" : "rejected — the violation stands as a regression"}\n`,
                          )
                        : chalk.red("\n  ✗ no such review id\n"),
                );
                return;
            }
            const reviews = contract.listReviews("pending");
            if ((opts as Record<string, unknown>)["json"]) {
                process.stdout.write(`${JSON.stringify(reviews, null, 2)}\n`);
                return;
            }
            if (reviews.length === 0) {
                console.log(dim("\n  No pending reviews — the contract matches observed behavior.\n"));
                return;
            }
            console.log(chalk.cyan(`\n  Pending behavior changes (${reviews.length})\n`));
            for (const r of reviews) {
                console.log(`  #${r.id} ${chalk.bold(r.route)} — ${r.action}`);
                console.log(dim(`      expected: ${r.expectedObservable.slice(0, 90)}`));
                console.log(chalk.yellow(`      observed: ${r.observed.slice(0, 90)}`));
            }
            console.log(
                dim("\n  Accept the change:  raiken contract review --accept <id>") +
                    dim("\n  Reject as regression: raiken contract review --reject <id>\n"),
            );
            console.log("");
            return;
        }

        case "watch": {
            const opts = options as Record<string, unknown>;
            const everySec = Math.max(30, Number(opts["every"] ?? 600));
            const webhook = opts["webhook"] as string | undefined;
            console.log(
                chalk.cyan(
                    `\n  Watching the contract — verifying every ${everySec}s${webhook ? `, alerts → ${webhook}` : ""}. Ctrl-C to stop.\n`,
                ),
            );
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            const storageStatePath = resolveAuthStorageStatePath(projectPath);
            let previous = new Map<string, string>();
            const runOnce = async (): Promise<void> => {
                try {
                    const result = await contract.verify({ verifyAll: true, storageStatePath });
                    const statusByKey = new Map(
                        contract.view().observed.map((f) => [f.factKey, f.status]),
                    );
                    const regressions: string[] = [];
                    for (const [key, status] of statusByKey) {
                        if (status === "violated" && previous.get(key) === "verified") {
                            regressions.push(key);
                        }
                    }
                    const violations = contract.violationsReport(result.verdicts);
                    const when = new Date().toTimeString().slice(0, 8);
                    console.log(
                        `  ${dim(when)}  ${result.verdicts.length - violations.length} verified · ${chalk.red(`${violations.length} violated`)}${regressions.length > 0 ? chalk.red(` · ${regressions.length} NEW`) : ""}`,
                    );
                    for (const v of violations) {
                        console.log(chalk.red(`    ✗ ${v.line}`));
                    }
                    if (regressions.length > 0 && webhook) {
                        try {
                            await fetch(webhook, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                    text: `raiken contract: ${regressions.length} behavior regression(s)`,
                                    violations: violations.map((v) => v.line),
                                }),
                            });
                        } catch (err) {
                            console.log(
                                chalk.yellow(
                                    `    ⚠ webhook failed: ${safeCliErrorMessage(err)}`,
                                ),
                            );
                        }
                    }
                    previous = statusByKey;
                } catch (err) {
                    console.log(
                        chalk.yellow(
                            `  verify failed: ${safeCliErrorMessage(err)} — retrying next cycle`,
                        ),
                    );
                }
            };
            await runOnce();
            const timer = setInterval(() => void runOnce(), everySec * 1000);
            await new Promise<void>((resolve) => {
                const stop = () => {
                    clearInterval(timer);
                    console.log(dim("\n  Watch stopped.\n"));
                    resolve();
                };
                process.once("SIGINT", stop);
                process.once("SIGTERM", stop);
            });
            return;
        }

        default:
            console.error(
                chalk.red(`\n  Unknown subcommand "${subcommand}".`) +
                    dim("  — show | coverage | capture | mint | import | export | diff | verify | review | history\n") +
            dim("     search | explore | materialize | routes | snapshot | record | watch\n"),
            );
            cliExit(CLI_EXIT.USAGE);
    }
}
