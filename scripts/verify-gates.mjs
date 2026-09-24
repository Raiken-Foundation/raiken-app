#!/usr/bin/env node
/**
 * `pnpm verify` — every reliability gate Raiken's accuracy work depends on, in
 * one command, in dependency order.
 *
 * The point is that "did the remediation hold?" has a single answer rather than
 * a checklist someone has to remember: static checks, unit suites, the
 * browser-backed integration and eval suites, and finally the hand-written
 * golden suite run repeatedly with retries disabled. A retry-free repeat is the
 * only run that can distinguish a fixed test from an intermittently lucky one,
 * so it is a gate rather than a convenience.
 *
 * Usage:
 *   node scripts/verify-gates.mjs                 # everything
 *   node scripts/verify-gates.mjs --list
 *   node scripts/verify-gates.mjs --only unit,integration
 *   node scripts/verify-gates.mjs --skip golden-suite
 *   node scripts/verify-gates.mjs --trials 3      # golden-suite repetitions
 *   node scripts/verify-gates.mjs --keep-going    # report all failures
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authFixtureDir = path.join(repoRoot, "tools", "playground-tasks");
const cliBin = path.join(repoRoot, "dist", "apps", "cli", "bin.cjs");

/** Tests in the hand-written golden suite. Ground truth: all of them pass. */
const GOLDEN_SUITE_TESTS = 12;
const GOLDEN_SUITE_FILE = "tests/auth-flow.spec.ts";

function parseArgs(argv) {
    const options = { only: null, skip: [], trials: 5, keepGoing: false, list: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--list") options.list = true;
        else if (arg === "--keep-going") options.keepGoing = true;
        else if (arg === "--only") options.only = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--skip") options.skip = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--trials") options.trials = Math.max(2, Number(argv[++i]) || 5);
        else throw new Error(`unknown argument "${arg}"`);
    }
    return options;
}

function buildGates(options) {
    return [
        {
            name: "static",
            description: "Biome formatting and lint",
            command: ["pnpm", ["exec", "biome", "check", "."]],
        },
        {
            name: "boundaries",
            description: "Module boundaries between cli, dashboard, shared, core",
            command: ["pnpm", ["run", "lint:boundaries"]],
        },
        {
            name: "typecheck",
            description: "TypeScript across every project",
            command: ["pnpm", ["run", "typecheck"]],
        },
        {
            name: "unit",
            description: "Unit suites (core, shared, cli, dashboard)",
            command: ["pnpm", ["run", "test"]],
        },
        {
            name: "build-cli",
            description: "Build the CLI the golden-suite gate runs",
            command: ["pnpm", ["exec", "nx", "build", "cli"]],
        },
        {
            name: "integration",
            description: "Browser-backed integration specs and the fixture eval suites",
            command: ["pnpm", ["run", "test:integration"]],
        },
        {
            name: "golden-suite",
            description: `Golden suite ${options.trials}× with retries disabled, expecting ${GOLDEN_SUITE_TESTS}/${GOLDEN_SUITE_TESTS}`,
            cwd: authFixtureDir,
            command: [
                process.execPath,
                [
                    cliBin,
                    "eval",
                    "flakiness",
                    GOLDEN_SUITE_FILE,
                    "--runs",
                    String(options.trials),
                    "--expect-tests",
                    String(GOLDEN_SUITE_TESTS),
                ],
            ],
            precondition: () =>
                fs.existsSync(cliBin)
                    ? null
                    : `missing built CLI at ${cliBin} — run the build-cli gate first`,
        },
    ];
}

function run(command, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
            env: process.env,
        });
        child.on("error", (error) => resolve({ code: 1, error: error.message }));
        child.on("close", (code) => resolve({ code: code ?? 1 }));
    });
}

function formatDuration(ms) {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const gates = buildGates(options).filter(
        (gate) =>
            (options.only === null || options.only.includes(gate.name)) &&
            !options.skip.includes(gate.name),
    );

    if (options.list) {
        for (const gate of gates) console.log(`${gate.name.padEnd(14)} ${gate.description}`);
        return 0;
    }
    if (gates.length === 0) {
        console.error("verify — no gates selected");
        return 2;
    }

    const results = [];
    for (const gate of gates) {
        const blocked = gate.precondition?.();
        if (blocked) {
            console.error(`\n▸ ${gate.name} — skipped: ${blocked}\n`);
            results.push({ name: gate.name, ok: false, durationMs: 0, detail: blocked });
            if (!options.keepGoing) break;
            continue;
        }

        console.log(`\n▸ ${gate.name} — ${gate.description}\n`);
        const startedAt = Date.now();
        const [command, args] = gate.command;
        const { code, error } = await run(command, args, gate.cwd ?? repoRoot);
        const durationMs = Date.now() - startedAt;
        results.push({ name: gate.name, ok: code === 0, durationMs, detail: error });
        if (code !== 0 && !options.keepGoing) break;
    }

    console.log("\nverify — gate results");
    for (const result of results) {
        const badge = result.ok ? "PASS" : "FAIL";
        const detail = result.detail ? ` (${result.detail})` : "";
        console.log(
            `  ${badge}  ${result.name.padEnd(14)} ${formatDuration(result.durationMs)}${detail}`,
        );
    }

    const notRun = gates.length - results.length;
    if (notRun > 0) console.log(`  ....  ${notRun} gate(s) not run after the first failure`);

    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
        console.error(`\nverify — FAILED: ${failed.map((result) => result.name).join(", ")}`);
        return 1;
    }
    console.log("\nverify — all gates passed");
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(`verify — ${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
    });
