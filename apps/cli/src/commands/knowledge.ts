import { createProjectApplication } from "@raiken/core";
import chalk from "chalk";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";
import { exitUsage } from "../errors";
import { confirmDestructive } from "./confirm-destructive";

interface KnowledgeOptions {
    limit?: string;
    json?: boolean;
    /** Skip the confirmation prompt for destructive actions (scripts / CI). */
    force?: boolean;
    /** REPL-injected confirm prompt (inquirer can't run inside the REPL). */
    confirm?: (message: string) => Promise<boolean>;
}

/**
 * `raiken knowledge [section]` — inspect the site-knowledge DB built by
 * `raiken discover`. Surfaces discovered pages, verified/broken links, and
 * unresolved blockers so a developer can see (and script against) everything
 * Raiken has learned about the running app — the same data the agent uses to
 * ground test generation.
 */
export async function knowledgeCommand(
    sub: string | undefined,
    arg: string | undefined,
    options: KnowledgeOptions,
): Promise<void> {
    const projectPath = process.cwd();
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const app = createProjectApplication(projectPath);
    const discovery = app.discovery;
    const limit = options.limit ? Math.max(1, Number(options.limit) || 50) : 50;
    const section = (sub || "overview").toLowerCase();

    const out = (value: unknown) => {
        restore?.();
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    };

    switch (section) {
        case "overview": {
            const sessionView = discovery.getSessionView();
            const stats = discovery.getStats();
            if (options.json) return out({ session: sessionView, stats });
            if (!sessionView) {
                console.log(dim("\n  No discovery data yet. Run `raiken discover <url>`.\n"));
                return;
            }
            const row = (l: string, v: string) => console.log(`  ${dim(l.padEnd(14))} ${v}`);
            console.log(accent("\n  Site knowledge") + dim(`  ·  ${sessionView.startUrl}`));
            row("Session", sessionView.status);
            row("Pages", String(stats.pagesCount));
            row(
                "Links",
                `${stats.verifiedLinksCount} verified · ${stats.brokenLinksCount} broken · ${stats.linksCount} total`,
            );
            row(
                "Blockers",
                `${stats.unresolvedBlockersCount} unresolved · ${stats.authBlockersCount} auth`,
            );
            console.log(dim("\n  Sections: pages · links · blockers · page <url> · clear\n"));
            return;
        }

        case "pages": {
            const result = discovery.listDiscoveredPages({ limit, offset: 0 });
            const res = {
                pages: result.pages,
                total: result.total,
                hasMore: result.hasMore,
            };
            if (options.json) return out(res);
            if (res.pages.length === 0) {
                console.log(dim("\n  No pages discovered. Run `raiken discover <url>`.\n"));
                return;
            }
            console.log(
                accent("\n  Discovered pages") + dim(`  (${res.pages.length}/${res.total})`),
            );
            for (const p of res.pages) {
                console.log(
                    `  ${dim(`d${p.depth}`)} ${chalk.white(p.title || "(untitled)")} ${dim(`· ${p.visitCount} visit(s)`)}`,
                );
                console.log(`      ${dim(p.url)}`);
            }
            if (res.hasMore) {
                console.log(dim(`\n  … ${res.total - res.pages.length} more — raise with --limit`));
            }
            console.log("");
            return;
        }

        case "links": {
            const res = discovery.getVerifiedLinks(limit);
            if (options.json) return out(res);
            console.log(
                accent("\n  Links") +
                    dim(`  (${res.verifiedCount} verified, ${res.brokenCount} broken)`),
            );
            if (res.verifiedLinks.length === 0 && res.brokenLinks.length === 0) {
                console.log(dim("  (none yet)\n"));
                return;
            }
            for (const l of res.verifiedLinks) {
                console.log(
                    `  ${chalk.green("✓")} ${chalk.white(l.linkText || l.selector || "(link)")}`,
                );
                console.log(`      ${dim(`${l.fromUrl} → ${l.toUrl}`)}`);
            }
            if (res.brokenLinks.length > 0) {
                console.log(accent("\n  Broken"));
                for (const l of res.brokenLinks) {
                    console.log(`  ${chalk.red("✗")} ${dim(`${l.fromUrl} → ${l.toUrl}`)}`);
                    if (l.errorMessage) console.log(`      ${dim(l.errorMessage)}`);
                }
            }
            console.log("");
            return;
        }

        case "blockers": {
            const { blockers, total } = discovery.getAuthBlockers();
            const res = { blockers, total };
            if (options.json) return out(res);
            if (res.total === 0) {
                console.log(dim("\n  No unresolved blockers.\n"));
                return;
            }
            console.log(accent("\n  Unresolved blockers") + dim(`  (${res.total})`));
            for (const b of res.blockers) {
                const kind = b.category || b.blockerType || "unknown";
                console.log(
                    `  ${chalk.yellow("✗")} ${chalk.white(kind)} ${dim(`[${b.severity}]`)}`,
                );
                console.log(`      ${dim(b.url)}`);
            }
            // getAuthBlockers returns ALL unresolved blockers despite the name —
            // only suggest `raiken auth` when one is actually auth-related
            // (an error_page blocker isn't cleared by logging in).
            if (res.blockers.some((b) => (b.category || b.blockerType) === "auth_required")) {
                console.log(dim("\n  Tip: run `raiken auth` to clear auth blockers.\n"));
            }
            return;
        }

        case "page": {
            if (!arg) {
                exitUsage("Usage: raiken knowledge page <url>");
            }
            let view = null;
            try {
                view = discovery.getDiscoveredPageSnapshot(arg);
            } catch {
                console.log(chalk.red(`  Invalid or unknown URL: ${arg}`));
                return;
            }
            if (options.json) return out(view);
            if (!view) {
                console.log(dim(`\n  No snapshot stored for ${arg}\n`));
                return;
            }
            console.log(accent(`\n  ${view.title || "(untitled)"}`) + dim(`  ·  ${view.url}`));
            console.log(
                `  ${dim("depth")} ${view.depth}   ${dim("discovered")} ${view.discoveredAt}`,
            );
            if (view.snapshotJson?.trim()) {
                const lines = view.snapshotJson.split("\n");
                console.log(accent("\n  Accessibility snapshot"));
                for (const line of lines.slice(0, 40)) console.log(dim(`  ${line}`));
                if (lines.length > 40) {
                    console.log(
                        dim(`  … ${lines.length - 40} more lines (use --json for the full tree)`),
                    );
                }
            }
            console.log("");
            return;
        }

        case "clear": {
            const ok = await confirmDestructive(
                "Clear all discovery knowledge (pages, links, blockers) for this project",
                { force: options.force, confirm: options.confirm },
            );
            if (!ok) {
                console.log(dim("\n  Clear cancelled.\n"));
                return;
            }
            await discovery.clearData();
            console.log(chalk.green("\n  ✓ Discovery data cleared.\n"));
            return;
        }

        default:
            exitUsage(
                `Unknown knowledge section: '${section}'\nSections: overview | pages | links | blockers | page <url> | clear`,
            );
    }
}
