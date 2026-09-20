import * as path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config used exclusively by Stryker mutation testing.
 *
 * Same as vitest.config.ts but additionally excludes browser-backed parity
 * specs (they launch real Chromium and are slow/flaky under Stryker's parallel
 * worker pool — and mutation testing targets pure logic, not browser I/O).
 */
export default defineConfig({
    root: __dirname,
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        exclude: [
            "src/**/*.integration.spec.ts",
            "src/browser/session/__tests__/dom-snapshot-builder.parity.spec.ts",
            "src/browser/session/__tests__/locator-resolver.parity.spec.ts",
            "src/browser/session/__tests__/session.parity.spec.ts",
            // process.chdir() is not supported in Stryker's worker-thread pool
            // (the vitest runner hardcodes pool: 'threads').
            "src/integrations/__tests__/branch-parser.spec.ts",
            // Resolves the tools/playground-tasks fixture relative to the repo
            // root, which is absent from Stryker's sandbox.
            "src/evals/__tests__/benchmark-scenarios.spec.ts",
        ],
        testTimeout: 15000,
    },
    resolve: {
        alias: {
            "@raiken/core": path.resolve(__dirname, "src/index.ts"),
        },
    },
});
