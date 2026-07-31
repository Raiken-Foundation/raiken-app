import type { DOMContext } from "@raiken/core";
import chalk from "chalk";
import { accent, dim } from "../../agent-stream";

/** Compact DOM summary for /snapshot and after DOM commands. */
export function renderSnapshot(dom: DOMContext): void {
    console.log(accent(`\n${dom.title || "(untitled)"}`), dim(`— ${dom.url}`));
    const els = dom.interactiveElements ?? [];
    if (els.length === 0) {
        console.log(dim("  (no interactive elements found)"));
        return;
    }
    for (const el of els.slice(0, 25)) {
        const sel = el.suggestedSelectors?.[0] ?? "";
        console.log(
            `  ${dim("•")} ${el.role}: ${chalk.white(`"${el.name || el.text || ""}"`)} ${dim(sel)}`,
        );
    }
    if (els.length > 25) console.log(dim(`  ... and ${els.length - 25} more`));
}

export function isMissingBrowserError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return (
        /playwright install/i.test(msg) ||
        /Executable doesn't exist/i.test(msg) ||
        /Failed to launch/i.test(msg)
    );
}

export function printPlaywrightInstallHint(): void {
    console.log(
        chalk.yellow("\n  ⚠  Playwright browser isn't installed.") +
            dim("\n     Run ") +
            accent("npx playwright install chromium") +
            dim(" and try again.\n"),
    );
}

export function splitAssign(arg: string): [string, string | undefined] {
    const spaced = arg.indexOf(" = ");
    if (spaced !== -1) {
        return [arg.slice(0, spaced).trim(), arg.slice(spaced + 3)];
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
        return [arg.slice(0, eq).trim(), arg.slice(eq + 1)];
    }
    return [arg.trim(), undefined];
}
