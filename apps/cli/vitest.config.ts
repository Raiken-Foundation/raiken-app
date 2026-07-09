import { defineConfig } from "vitest/config";

export default defineConfig({
    // Pin the root to this config's directory so tests resolve the same way
    // whether vitest is run from the repo root or via the nx executor (which
    // runs with cwd = apps/cli).
    root: __dirname,
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        testTimeout: 15000,
    },
});
