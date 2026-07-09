import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";

interface KnowledgeOptions {
    limit?: string;
    json?: boolean;
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
    const caller = appRouter.createCaller({ projectPath });
    const limit = options.limit ? Math.max(1, Number(options.limit) || 50) : 50;
    const section = (sub || "overview").toLowerCase();

    const out = (value: unknown) => {
        restore?.();
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    };

    switch (section) {
        case "overview": {
            const [session, stats] = await Promise.all([
                caller.getDiscoverySession({}),
                caller.getDiscoveryStats({}),
            ]);
            if (options.json) return out({ session, stats });
            if (!session) {
                console.log(dim("\n  No discovery data yet. Run `raiken discover <url>`.\n"));
                return;
            }
            const row = (l: string, v: string) => console.log(`  ${dim(l.padEnd(14))} ${v}`);
            console.log(accent("\n  Site knowledge") + dim(`  ·  ${session.startUrl}`));
            row("Session", session.status);
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
            const res = await caller.getDiscoveredPages({ limit });
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
            const res = await caller.getVerifiedLinks({ limit });
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
            const res = await caller.getAuthBlockers({});
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
            console.log(dim("\n  Tip: run `raiken auth` to clear auth blockers.\n"));
            return;
        }

        case "page": {
            if (!arg) {
                console.log(chalk.red("  usage: raiken knowledge page <url>"));
                return;
            }
            let page: Awaited<ReturnType<typeof caller.getDiscoveredPageSnapshot>> = null;
            try {
                page = await caller.getDiscoveredPageSnapshot({ url: arg });
            } catch {
                console.log(chalk.red(`  Invalid or unknown URL: ${arg}`));
                return;
            }
            if (options.json) return out(page);
            if (!page) {
                console.log(dim(`\n  No snapshot stored for ${arg}\n`));
                return;
            }
            console.log(accent(`\n  ${page.title || "(untitled)"}`) + dim(`  ·  ${page.url}`));
            console.log(
                `  ${dim("depth")} ${page.depth}   ${dim("discovered")} ${page.discoveredAt}`,
            );
            // The snapshot is Playwright's ARIA accessibility tree (a YAML-like
            // text outline) — the same structure the agent grounds test
            // generation on. Render it directly, capped so a huge page stays
            // scannable (use --json for the full snapshot).
            if (page.snapshotJson?.trim()) {
                const lines = page.snapshotJson.split("\n");
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
            await caller.clearDiscoveryData({});
            console.log(chalk.green("\n  ✓ Discovery data cleared.\n"));
            return;
        }

        default:
            console.log(
                chalk.red(`  Unknown section: ${section}`) +
                    dim("  — pages | links | blockers | page <url> | clear"),
            );
    }
}
