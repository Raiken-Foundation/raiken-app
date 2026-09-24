import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    detectDevServerPort,
    extractPortFlag,
    readPlaywrightBaseURL,
    readPlaywrightTestMatch,
} from "../testing";

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-port-detector-"));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("detectDevServerPort", () => {
    it("returns the fallback when no project config is present", async () => {
        await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "x" }));
        const port = await detectDevServerPort(tmpDir, 3000);
        expect(port).toBe(3000);
    });

    it("reads server.port from vite.config.ts", async () => {
        await fs.writeFile(
            path.join(tmpDir, "vite.config.ts"),
            `import { defineConfig } from 'vite';
             export default defineConfig({
               plugins: [],
               server: { host: 'localhost', port: 5180 },
             });`,
        );
        const port = await detectDevServerPort(tmpDir, 3000);
        expect(port).toBe(5180);
    });

    it("reads server.port from vite.config.mjs across line breaks", async () => {
        await fs.writeFile(
            path.join(tmpDir, "vite.config.mjs"),
            `export default {
                server: {
                    host: 'localhost',
                    // Listen on the corp dev port
                    port: 4242,
                    strictPort: true,
                },
             };`,
        );
        expect(await detectDevServerPort(tmpDir)).toBe(4242);
    });

    it("ignores vite configs with no server.port and falls through", async () => {
        await fs.writeFile(path.join(tmpDir, "vite.config.ts"), `export default { plugins: [] };`);
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { dev: "vite --port 7777" } }),
        );
        expect(await detectDevServerPort(tmpDir, 3000)).toBe(7777);
    });

    it("reads angular.json projects.<name>.architect.serve.options.port", async () => {
        await fs.writeFile(
            path.join(tmpDir, "angular.json"),
            JSON.stringify({
                projects: {
                    "my-app": {
                        architect: {
                            serve: { options: { port: 4300 } },
                        },
                    },
                },
            }),
        );
        expect(await detectDevServerPort(tmpDir)).toBe(4300);
    });

    it("survives malformed angular.json", async () => {
        await fs.writeFile(path.join(tmpDir, "angular.json"), "{ broken json");
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { start: "ng serve --port=4400" } }),
        );
        expect(await detectDevServerPort(tmpDir, 3000)).toBe(4400);
    });

    it("reads --port flag from package.json scripts.dev", async () => {
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { dev: "next dev --port 4001" } }),
        );
        expect(await detectDevServerPort(tmpDir)).toBe(4001);
    });

    it("reads -p shorthand from scripts.start", async () => {
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { start: "node server.js -p 8080" } }),
        );
        expect(await detectDevServerPort(tmpDir)).toBe(8080);
    });

    it("prefers vite over package.json scripts when both define a port", async () => {
        await fs.writeFile(
            path.join(tmpDir, "vite.config.ts"),
            "export default { server: { port: 5555 } };",
        );
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { dev: "vite --port 9999" } }),
        );
        expect(await detectDevServerPort(tmpDir)).toBe(5555);
    });

    it("rejects ports outside the valid TCP range and falls back", async () => {
        await fs.writeFile(
            path.join(tmpDir, "package.json"),
            JSON.stringify({ scripts: { dev: "node x --port 99999" } }),
        );
        expect(await detectDevServerPort(tmpDir, 3000)).toBe(3000);
    });
});

describe("extractPortFlag", () => {
    it("matches --port N", () => {
        expect(extractPortFlag("vite --port 3000 --strictPort")).toBe(3000);
    });

    it("matches --port=N", () => {
        expect(extractPortFlag("ng serve --port=4500")).toBe(4500);
    });

    it("matches -p N", () => {
        expect(extractPortFlag("foo -p 8000")).toBe(8000);
    });

    it("does not match -p inside a longer flag", () => {
        expect(extractPortFlag("foo --strict-p 1234")).toBeNull();
    });

    it("returns null when no port flag present", () => {
        expect(extractPortFlag("vite")).toBeNull();
    });
});

describe("readPlaywrightBaseURL", () => {
    it("returns null when no playwright config exists", async () => {
        expect(await readPlaywrightBaseURL(tmpDir)).toBeNull();
    });

    it("extracts a static baseURL from playwright.config.ts", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.ts"),
            `import { defineConfig } from '@playwright/test';
             export default defineConfig({
               use: {
                 baseURL: 'http://localhost:3000',
                 trace: 'on-first-retry',
               },
             });`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBe("http://localhost:3000");
    });

    it("extracts baseURL from playwright.config.mjs with double quotes", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.mjs"),
            `export default { use: { baseURL: "https://staging.example.com" } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBe("https://staging.example.com");
    });

    it("returns null for a dynamic baseURL (process.env)", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.ts"),
            `export default { use: { baseURL: process.env.BASE_URL } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBeNull();
    });

    // Below: cases added for Issue 5 (dashboard pre-fills the Discovery
    // Start URL from this value). The dashboard surfaces `null` as
    // "fall back to the generic placeholder" so the missing-baseURL
    // case must reliably return `null` rather than something truthy.

    it("returns null when the config exists but has no baseURL field", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.ts"),
            `export default { testDir: './e2e', use: { trace: 'on-first-retry' } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBeNull();
    });

    it("extracts a baseURL written as a template literal", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.ts"),
            `export default { use: { baseURL: \`http://localhost:5100\` } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBe("http://localhost:5100");
    });

    it("reads playwright.config.cjs", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.cjs"),
            `module.exports = { use: { baseURL: 'http://localhost:4200' } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBe("http://localhost:4200");
    });

    it("reads playwright.config.mts", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.mts"),
            `export default { use: { baseURL: 'http://127.0.0.1:5173' } };`,
        );
        expect(await readPlaywrightBaseURL(tmpDir)).toBe("http://127.0.0.1:5173");
    });
});

describe("readPlaywrightTestMatch", () => {
    it("extracts a static string array", async () => {
        await fs.writeFile(
            path.join(tmpDir, "playwright.config.ts"),
            `export default { testMatch: ["workflows.spec.ts", "**/*.spec.ts"] };`,
        );
        expect(await readPlaywrightTestMatch(tmpDir)).toEqual([
            "workflows.spec.ts",
            "**/*.spec.ts",
        ]);
    });

    it("returns null when absent", async () => {
        await fs.writeFile(path.join(tmpDir, "playwright.config.ts"), `export default {};`);
        expect(await readPlaywrightTestMatch(tmpDir)).toBeNull();
    });
});
