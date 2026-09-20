import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: __dirname,
    plugins: [nxViteTsPaths()],
    test: {
        reporters: ["default"],
        globals: true,
        environment: "node",
        pool: "forks",
        maxWorkers: 4,
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        testTimeout: 15000,
    },
});
