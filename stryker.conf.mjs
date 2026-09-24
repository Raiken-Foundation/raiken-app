// @ts-check
// Stryker mutation-testing config for the libs/core logic layer.
// Run under Node 22 (matching .nvmrc) — better-sqlite3 is compiled for that ABI.
//
//   nvm use 22
//   pnpm exec stryker run                # full run
//   pnpm exec stryker run --dryRunOnly   # validate setup without mutating

export default {
    packageManager: "pnpm",

    plugins: ["@stryker-mutator/vitest-runner"],

    testRunner: "vitest",
    vitest: {
        configFile: "libs/core/vitest.stryker.config.ts",
        dir: "libs/core",
        related: false,
    },

    // Focused run: pure-logic files only (no DB / browser / process imports),
    // so the run is fast and the survivor list is unpolluted by native-module
    // segfaults or browser flakiness. Expand to "libs/core/src/**/*.{ts,tsx}"
    // (plus the spec/index/types excludes) for the full layer.
    mutate: [
        "libs/core/src/agent/graph/utils.ts",
        "libs/core/src/observability/redaction.ts",
        "libs/core/src/observability/context.ts",
        "libs/core/src/observability/logger.ts",
        "libs/core/src/observability/project-path.ts",
        "libs/core/src/errors/raiken-error.ts",
        "libs/core/src/errors/serialize.ts",
        "libs/core/src/errors/redact.ts",
        "libs/core/src/organize/path-utils.ts",
        "libs/core/src/analysis/ast-parser.ts",
        "libs/core/src/analysis/markup-selectors.ts",
        "libs/core/src/analysis/source-analysis.ts",
        "libs/core/src/analysis/sfc.ts",
    ],

    // Skip static string/number/boolean literal mutations — they mostly
    // produce noise. Keep operator/condition/statement mutations.
    // NOTE: ignoreStatic requires coverageAnalysis "perTest".
    ignoreStatic: true,

    // "perTest" is fast (only runs the tests that cover each mutant), but it
    // under-reports mutations to module-level `export const` regex/array
    // declarations (evaluated at import time, not inside any test). For the
    // most accurate score on regex-heavy files (e.g. errors/redact.ts), switch
    // to coverageAnalysis "all" + ignoreStatic false at the cost of a much
    // slower run.
    coverageAnalysis: "perTest",

    ignorePatterns: [
        "node_modules",
        "dist",
        "tmp",
        "tools",
        "apps",
        ".nx",
        "coverage",
        "reports",
        ".stryker-tmp",
    ],

    reporters: ["clear-text", "html", "progress"],

    htmlReporter: {
        fileName: "reports/mutation.html",
    },

    thresholds: {
        high: 80,
        low: 60,
        break: null, // don't fail the build yet; ratchet later
    },

    timeoutMS: 30000,
    cleanTempDir: "always",
    tempDirName: ".stryker-tmp",
};
