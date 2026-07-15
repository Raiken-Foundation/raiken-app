/**
 * Live end-to-end run of the playground eval suite: starts the fixture apps,
 * crawls them with the real SiteDiscovery + Playwright, and asserts the
 * scored report. Slower than a unit spec (real browser, real crawl) but this
 * is exactly the regression net the harness exists to provide — agent-facing
 * behavior that unit tests structurally miss.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalScenarios } from "../runner";
import { buildPlaygroundScenarios } from "../scenarios/playground";

const TOOLS_DIR = path.join(__dirname, "..", "..", "..", "..", "..", "tools");
const HAVE_FIXTURES =
    fs.existsSync(path.join(TOOLS_DIR, "playground", "dist", "index.html")) &&
    fs.existsSync(path.join(TOOLS_DIR, "playground-auth", "server.mjs"));

describe.skipIf(!HAVE_FIXTURES)("playground eval suite (integration)", () => {
    it(
        "discovery and auth-wall scenarios pass against the live fixtures",
        { timeout: 180_000 },
        async () => {
            const scenarios = buildPlaygroundScenarios({
                playgroundDir: path.join(TOOLS_DIR, "playground"),
                authPlaygroundDir: path.join(TOOLS_DIR, "playground-auth"),
            });

            const report = await runEvalScenarios(scenarios);

            const failures = report.scenarios
                .filter((scenario) => !scenario.skipped && scenario.passRate < 1)
                .map((scenario) => {
                    const attempt = scenario.attempts[0];
                    const failed = attempt?.scores
                        .filter((score) => !score.passed)
                        .map((score) => `${score.name}: ${score.detail ?? "failed"}`)
                        .join("; ");
                    return `${scenario.id} — ${attempt?.error ?? failed}`;
                });
            expect(failures, failures.join("\n")).toEqual([]);
            expect(report.passed).toBe(true);
        },
    );
});
