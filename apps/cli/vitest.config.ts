import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    // Pin the root to this config's directory so tests resolve the same way
    // whether vitest is run from the repo root or via the nx executor (which
    // runs with cwd = apps/cli).
    root: __dirname,
    // Resolves the `@raiken/core` / `@raiken/shared` tsconfig path aliases —
    // needed the moment any command spec imports (even transitively) from
    // those packages, same as the dashboard's vite config already does.
    plugins: [nxViteTsPaths()],
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        maxWorkers: 4,
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        testTimeout: 30000,
    },
});
