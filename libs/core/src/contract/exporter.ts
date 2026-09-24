import { computeCoverage, COVERAGE_MATCH_THRESHOLD } from "./coverage";
import { ContractStore } from "./store";
import type { ContractView } from "./types";

/**
 * Contract export: the readable, git-diffable artifact. `contract.md` is the
 * human review surface (PR diffs show exactly which behaviors changed);
 * `contract.json` is the machine surface (tooling, MCP). `diff` compares a
 * fresh view against the last exported snapshot so "what changed about the
 * app's behavior" is one command.
 */

export function buildContractView(
    store: ContractStore,
    projectPath: string,
    withCoverage = true,
): ContractView {
    return {
        projectPath,
        observed: store.listBehaviorFacts(),
        intent: store.listIntentFacts(),
        coverage: withCoverage ? computeCoverage(store) : null,
        exportedAt: Date.now(),
    };
}

export function contractToMarkdown(view: ContractView): string {
    const lines: string[] = [];
    lines.push("# Behavior Contract");
    lines.push("");
    lines.push(`_Observed: ${view.observed.length} facts · Intent: ${view.intent.length} requirements · Exported: ${iso(view.exportedAt)}_`);
    lines.push("");

    lines.push("## Observed — what the app does");
    lines.push("");
    if (view.observed.length === 0) {
        lines.push("_No observed facts yet. Run `raiken contract capture` or discovery._");
    }
    for (const fact of view.observed) {
        const status = fact.status === "verified" ? " " : ` [${fact.status}]`;
        lines.push(
            `- **${fact.route}**${fact.precondition ? ` _(${fact.precondition})_` : ""}: ${fact.action} → ${fact.expectedObservable}${status}`,
        );
    }
    lines.push("");

    lines.push("## Intent — what the business requires");
    lines.push("");
    if (view.intent.length === 0) {
        lines.push("_No requirements imported yet. `raiken contract import <file|ticket>`._");
    }
    for (const intent of view.intent) {
        const origin = intent.ticketId ? ` [#${intent.ticketId}]` : "";
        const flag = intent.neverRegress ? " 🔒never-regress" : "";
        lines.push(`- [${intent.status}] ${intent.requirementText}${origin}${flag}`);
    }
    lines.push("");

    if (view.coverage) {
        const c = view.coverage;
        lines.push("## Coverage — intent vs observed");
        lines.push("");
        lines.push(
            `**${c.covered}/${c.total} covered · ${c.uncovered} uncovered · ${c.violated} violated**${
                c.neverRegressUncovered > 0 ? ` · ⚠ ${c.neverRegressUncovered} never-regress uncovered` : ""
            }`,
        );
        lines.push("");
        for (const entry of c.entries.filter((e) => e.verdict !== "covered")) {
            lines.push(`- **[${entry.verdict}]** ${entry.intent.requirementText}`);
            if (entry.intent.neverRegress) lines.push("  - 🔒 fixed bug regressing — nothing currently covers it");
        }
        lines.push("");
    }

    return lines.join("\n");
}

export function contractToJson(view: ContractView): string {
    return JSON.stringify(view, null, 2);
}

export interface ContractDiff {
    addedFacts: string[];
    removedFacts: string[];
    statusChanged: Array<{ key: string; from: string; to: string }>;
    addedIntent: string[];
    removedIntent: string[];
    coverageChanged: Array<{ key: string; from: string; to: string }>;
}

/** Diff two contract views by stable keys. */
export function diffContracts(before: ContractView, after: ContractView): ContractDiff {
    const beforeFacts = new Map(before.observed.map((f) => [f.factKey, f]));
    const afterFacts = new Map(after.observed.map((f) => [f.factKey, f]));
    const beforeIntent = new Map(before.intent.map((i) => [i.requirementKey, i]));
    const afterIntent = new Map(after.intent.map((i) => [i.requirementKey, i]));

    const fmt = (f: { route: string; action: string; expectedObservable: string }) =>
        `${f.route}: ${f.action} → ${f.expectedObservable}`;

    return {
        addedFacts: [...afterFacts.values()].filter((f) => !beforeFacts.has(f.factKey)).map(fmt),
        removedFacts: [...beforeFacts.values()].filter((f) => !afterFacts.has(f.factKey)).map(fmt),
        statusChanged: [...afterFacts.values()]
            .filter((f) => beforeFacts.get(f.factKey) && beforeFacts.get(f.factKey)!.status !== f.status)
            .map((f) => ({
                key: fmt(f),
                from: beforeFacts.get(f.factKey)!.status,
                to: f.status,
            })),
        addedIntent: [...afterIntent.values()]
            .filter((i) => !beforeIntent.has(i.requirementKey))
            .map((i) => i.requirementText),
        removedIntent: [...beforeIntent.values()]
            .filter((i) => !afterIntent.has(i.requirementKey))
            .map((i) => i.requirementText),
        coverageChanged: [...afterIntent.values()]
            .filter((i) => beforeIntent.get(i.requirementKey) && beforeIntent.get(i.requirementKey)!.status !== i.status)
            .map((i) => ({
                key: i.requirementText,
                from: beforeIntent.get(i.requirementKey)!.status,
                to: i.status,
            })),
    };
}

export { COVERAGE_MATCH_THRESHOLD };

function iso(epoch: number): string {
    return new Date(epoch).toISOString();
}
