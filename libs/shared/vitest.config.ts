import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: __dirname,
    plugins: [nxViteTsPaths()],
    test: {
        globals: true,
        environment: "node",
        pool: "forks",
        include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
        testTimeout: 15000,
    },
});
