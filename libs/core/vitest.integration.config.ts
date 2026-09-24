import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: __dirname,
    test: {
        reporters: ["default"],
        globals: true,
        environment: "node",
        pool: "forks",
        fileParallelism: false,
        include: ["src/**/*.integration.spec.ts", "src/browser/session/__tests__/*.parity.spec.ts"],
        testTimeout: 60000,
        hookTimeout: 30000,
    },
    resolve: {
        alias: {
            "@raiken/core": path.resolve(__dirname, "src/index.ts"),
        },
    },
});
