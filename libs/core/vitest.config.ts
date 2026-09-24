import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    // Pin the root to this config's directory so tests resolve the same way
    // whether vitest is run from the repo root or via the nx executor (which
    // runs with cwd = libs/core). Without this the include globs below only
    // matched when cwd happened to be the repo root.
    root: __dirname,
    test: {
        reporters: ["default"],
        globals: true,
        environment: "node",
        pool: "forks",
        maxWorkers: 4,
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        exclude: ["src/**/*.integration.spec.ts", "src/browser/session/__tests__/*.parity.spec.ts"],
        testTimeout: 15000,
    },
    resolve: {
        alias: {
            "@raiken/core": path.resolve(__dirname, "src/index.ts"),
        },
    },
});
