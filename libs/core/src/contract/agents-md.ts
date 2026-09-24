import * as fs from "node:fs";
import * as path from "node:path";
import { computeCoverage, type ContractView } from "../contract";

/**
 * AGENTS.md emission: the contract, written where coding agents already read.
 *
 * Agents (Claude Code, Cursor, Copilot) consult AGENTS.md/CLAUDE.md on every
 * session start — a Raiken section there puts coverage state, never-regress
 * requirements, and the contract commands into every agent's memory for free.
 * Sections are idempotent: re-running refreshes the Raiken block in place.
 */

export const AGENTS_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

const SECTION_MARKER = "<!-- raiken-contract -->";

export function buildAgentsSection(view: ContractView): string {
    const lines: string[] = [];
    lines.push(SECTION_MARKER);
    lines.push("");
    lines.push("## Behavior Contract (Raiken)");
    lines.push("");
    if (view.coverage) {
        const c = view.coverage;
        lines.push(
            `Requirement coverage: **${c.covered}/${c.total} covered** · ${c.uncovered} uncovered · ${c.violated} violated.`,
        );
    }
    if (view.intent.some((i) => i.neverRegress && i.status !== "covered")) {
        lines.push("");
        lines.push("Never-regress requirements currently at risk:");
        for (const intent of view.intent.filter((i) => i.neverRegress && i.status !== "covered")) {
            lines.push(`- ${intent.requirementText}`);
        }
    }
    lines.push("");
    lines.push("Commands:");
    lines.push("- `raiken contract show` — facts, requirements, confidence");
    lines.push("- `raiken contract verify` — diff-scoped re-observation (CI-safe, exit 1 on violations)");
    lines.push("- `raiken contract coverage` — requirement coverage");
    lines.push("- `raiken contract materialize` — regenerate Playwright specs from facts");
    lines.push("");
    lines.push(
        "Test code materialized from facts is disposable — edit the contract, not the specs.",
    );
    lines.push("");
    lines.push(`${SECTION_MARKER}`);
    return lines.join("\n");
}

export interface AgentsEmitResult {
    filePath: string | null;
    created: boolean;
    refreshed: boolean;
}

/** Append/refresh the Raiken section in the project's AGENTS.md or CLAUDE.md. */
export function emitAgentsSection(
    projectPath: string,
    view: ContractView,
): AgentsEmitResult {
    const target = AGENTS_FILE_CANDIDATES.map((name) => path.join(projectPath, name)).find((p) =>
        fs.existsSync(p),
    );
    if (!target) return { filePath: null, created: false, refreshed: false };

    const section = buildAgentsSection(view);
    const existing = fs.readFileSync(target, "utf-8");
    const start = existing.indexOf(SECTION_MARKER);
    const end = existing.lastIndexOf(SECTION_MARKER);

    let next: string;
    let refreshed = false;
    if (start !== -1 && end > start) {
        next = existing.slice(0, start) + section + existing.slice(end + SECTION_MARKER.length);
        refreshed = true;
    } else {
        next = existing.trimEnd() + "\n\n" + section + "\n";
    }
    fs.writeFileSync(target, next, "utf-8");
    return { filePath: target, created: !refreshed, refreshed };
}
