/// <reference types='vitest' />

import { nxCopyAssetsPlugin } from "@nx/vite/plugins/nx-copy-assets.plugin";
import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

const plugins = [
    react(),
    tailwindcss(),
    nxViteTsPaths(),
    nxCopyAssetsPlugin(["*.md"]),
] as unknown as PluginOption[];

export default defineConfig(() => ({
    root: import.meta.dirname,
    cacheDir: "../../node_modules/.vite/apps/dashboard",

    server: {
        port: 4200,
        host: "localhost",
        proxy: {
            "/api": {
                target: "http://localhost:7101", // Points to your CLI Fastify server
                changeOrigin: true,
                secure: false,
            },
            // (Future Proofing) For real-time test logs later
            "/ws": {
                target: "ws://localhost:7101",
                ws: true,
            },
        },
        // -----------------------------------------------
    },

    preview: {
        port: 4200,
        host: "localhost",
    },

    plugins,

    build: {
        outDir: "../../dist/apps/dashboard",
        emptyOutDir: true,
        reportCompressedSize: true,
        commonjsOptions: {
            transformMixedEsModules: true,
        },
    },

    test: {
        name: "dashboard",
        watch: false,
        globals: true,
        environment: "jsdom",
        include: ["{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
        reporters: ["default"],
        testTimeout: 15000,
        coverage: {
            reportsDirectory: "../../coverage/apps/dashboard",
            provider: "v8" as const,
        },
    },
}));
