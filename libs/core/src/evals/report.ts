/**
 * Console rendering for eval reports. JSON output is just the report object;
 * this is the human view.
 */

import type { EvalReport } from "./types";

export function formatEvalReport(report: EvalReport): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(`Eval report — ${report.scenarios.length} scenario(s), repeat ×${report.repeat}`);
    lines.push("");

    for (const scenario of report.scenarios) {
        if (scenario.skipped) {
            lines.push(`  ○ ${scenario.id} — skipped (${scenario.skipped})`);
            continue;
        }
        const mark = scenario.passRate === 1 ? "✓" : "✗";
        const rate = `${Math.round(scenario.passRate * 100)}%`;
        lines.push(`  ${mark} ${scenario.id} — ${rate} (${scenario.attempts.length} attempt(s))`);
        lines.push(`      ${scenario.description}`);

        // Per-scorer aggregation across attempts: how often did each pass?
        const scorerNames = new Set(
            scenario.attempts.flatMap((attempt) => attempt.scores.map((score) => score.name)),
        );
        for (const name of scorerNames) {
            const relevant = scenario.attempts.flatMap((attempt) =>
                attempt.scores.filter((score) => score.name === name),
            );
            const passedCount = relevant.filter((score) => score.passed).length;
            const sample = relevant.find((score) => !score.passed) ?? relevant[0];
            const detail = sample?.detail ? ` — ${sample.detail}` : "";
            lines.push(`      · ${name}: ${passedCount}/${relevant.length}${detail}`);
        }
        for (const attempt of scenario.attempts) {
            if (attempt.error) {
                lines.push(`      · attempt ${attempt.attempt} errored: ${attempt.error}`);
            }
        }
    }

    lines.push("");
    lines.push(
        report.passed
            ? `PASS (${Math.round(report.durationMs / 1000)}s)`
            : `FAIL (${Math.round(report.durationMs / 1000)}s)`,
    );
    return lines.join("\n");
}
