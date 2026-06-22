import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        include: ["libs/core/src/**/*.spec.ts", "libs/core/src/**/*.test.ts"],
        testTimeout: 15000,
    },
    resolve: {
        alias: {
            "@raiken/core": path.resolve(__dirname, "src/index.ts"),
        },
    },
});
