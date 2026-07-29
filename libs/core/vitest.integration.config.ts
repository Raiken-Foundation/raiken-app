import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: __dirname,
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        fileParallelism: false,
        include: ["src/**/*.integration.spec.ts"],
        testTimeout: 60000,
        hookTimeout: 30000,
    },
    resolve: {
        alias: {
            "@raiken/core": path.resolve(__dirname, "src/index.ts"),
        },
    },
});
