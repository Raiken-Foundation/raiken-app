import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    findWebServerRunScripts,
    hasChromiumBrowser,
    parseNodeEngines,
    resolvePlaywrightBrowsersPath,
    scanEnvironment,
} from "../doctor/environment";

let projectPath: string;
let browsersPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-doctor-env-"));
    browsersPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-pw-browsers-"));
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    fs.rmSync(browsersPath, { recursive: true, force: true });
});

function scan(extra: Parameters<typeof scanEnvironment>[0] = {}) {
    return scanEnvironment({
        projectPath,
        testDirectory: "e2e",
        env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
        probeUrl: async () => true,
        // Hermetic defaults: a supported Node and a working native module,
        // so assertions below don't depend on the dev machine's runtime.
        nodeVersion: "22.22.1",
        probeNativeModule: () => {},
        ...extra,
    });
}

function installPlaywrightPackage(): void {
    const pkgDir = path.join(projectPath, "node_modules", "@playwright", "test");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@playwright/test" }),
    );
}

function installChromium(): void {
    fs.mkdirSync(path.join(browsersPath, "chromium-1148"), { recursive: true });
}

describe("findWebServerRunScripts", () => {
    it("extracts npm/pnpm/yarn script names from webServer commands", () => {
        expect(
            findWebServerRunScripts(
                `webServer: { command: 'npm run dev', url: 'http://localhost:3000' }`,
            ),
        ).toEqual(["dev"]);
        expect(findWebServerRunScripts('command: "pnpm start:ci"')).toEqual(["start:ci"]);
        expect(findWebServerRunScripts("command: `yarn serve`")).toEqual(["serve"]);
        expect(findWebServerRunScripts("command: 'npx vite'")).toEqual([]);
    });

    it("ignores commented-out webServer blocks (the raiken init no-dev-script shape)", () => {
        expect(
            findWebServerRunScripts(
                `export default {
                    use: { baseURL: 'http://localhost:3000' },
                    // webServer: {
                    //   command: 'npm run dev',
                    //   url: 'http://localhost:3000',
                    // },
                };`,
            ),
        ).toEqual([]);
    });

    it("ignores block comments but keeps URLs inside strings", () => {
        expect(
            findWebServerRunScripts(
                `/* webServer: { command: 'npm run old' } */
                export default {
                    webServer: { command: 'npm run dev', url: 'http://localhost:3000' },
                };`,
            ),
        ).toEqual(["dev"]);
    });

    it("does not strip // sequences inside string literals", () => {
        // A naive line-stripper would cut 'http://…' at the slashes and could
        // drop the real command when it follows the URL on the same line.
        expect(
            findWebServerRunScripts(
                `export default { webServer: { url: 'http://localhost:3000', command: 'npm run dev' } };`,
            ),
        ).toEqual(["dev"]);
    });
});

describe("resolvePlaywrightBrowsersPath / hasChromiumBrowser", () => {
    it("honors PLAYWRIGHT_BROWSERS_PATH and detects chromium builds", () => {
        expect(
            resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/x" }, "linux", "/h"),
        ).toBe("/x");
        expect(hasChromiumBrowser(browsersPath)).toBe(false);
        installChromium();
        expect(hasChromiumBrowser(browsersPath)).toBe(true);
    });

    it("resolves platform defaults when no override is set", () => {
        expect(resolvePlaywrightBrowsersPath({}, "darwin", "/home/u")).toBe(
            path.join("/home/u", "Library", "Caches", "ms-playwright"),
        );
        expect(resolvePlaywrightBrowsersPath({}, "linux", "/home/u")).toBe(
            path.join("/home/u", ".cache", "ms-playwright"),
        );
    });
});

describe("scanEnvironment", () => {
    it("flags a project with no Playwright installation", async () => {
        const findings = await scan();
        const rule = findings.find((f) => f.rule === "playwright-package-missing");
        expect(rule?.severity).toBe("error");
        // Browser check is skipped when the package itself is absent.
        expect(findings.some((f) => f.rule === "playwright-browsers-missing")).toBe(false);
    });

    it("flags missing browser binaries once the package is installed", async () => {
        installPlaywrightPackage();
        const findings = await scan();
        expect(findings.some((f) => f.rule === "playwright-browsers-missing")).toBe(true);
        installChromium();
        const after = await scan();
        expect(after.some((f) => f.rule === "playwright-browsers-missing")).toBe(false);
    });

    it("catches the golden-path bug: webServer points at a missing npm script", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: {} }));
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default { webServer: { command: 'npm run dev', url: 'http://localhost:3000' } };`,
        );
        const findings = await scan();
        const finding = findings.find((f) => f.rule === "webserver-script-missing");
        expect(finding?.severity).toBe("error");
        expect(finding?.message).toContain('"dev"');
    });

    it("does not flag the webServer script when package.json declares it", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.writeFileSync(
            path.join(projectPath, "package.json"),
            JSON.stringify({ scripts: { dev: "vite" } }),
        );
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default { webServer: { command: 'npm run dev', url: 'http://localhost:3000' } };`,
        );
        const findings = await scan();
        expect(findings.some((f) => f.rule === "webserver-script-missing")).toBe(false);
    });

    it("warns when baseURL is unreachable and no webServer will start the app", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };`,
        );
        const findings = await scan({ probeUrl: async () => false });
        const finding = findings.find((f) => f.rule === "baseurl-unreachable");
        expect(finding?.severity).toBe("warning");

        // A reachable app silences the check.
        const reachable = await scan({ probeUrl: async () => true });
        expect(reachable.some((f) => f.rule === "baseurl-unreachable")).toBe(false);
    });

    it("skips the baseURL probe when a webServer block exists", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.writeFileSync(
            path.join(projectPath, "package.json"),
            JSON.stringify({ scripts: { dev: "vite" } }),
        );
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default {
                use: { baseURL: 'http://localhost:3000' },
                webServer: { command: 'npm run dev', url: 'http://localhost:3000' },
            };`,
        );
        let probed = false;
        const findings = await scan({
            probeUrl: async () => {
                probed = true;
                return false;
            },
        });
        expect(probed).toBe(false);
        expect(findings.some((f) => f.rule === "baseurl-unreachable")).toBe(false);
    });

    it("treats a commented-out webServer as absent, not as a missing script", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: {} }));
        // The exact shape `raiken init` writes when package.json has no dev
        // script: webServer present but fully commented out.
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default {
                use: { baseURL: 'http://localhost:3000' },
                // webServer: {
                //   command: 'npm run dev',
                //   url: 'http://localhost:3000',
                // },
            };`,
        );
        const findings = await scan({ probeUrl: async () => false });
        expect(findings.some((f) => f.rule === "webserver-script-missing")).toBe(false);
        // No real webServer → the baseURL probe applies instead.
        expect(findings.some((f) => f.rule === "baseurl-unreachable")).toBe(true);
    });

    it("flags an invalid raiken.config.json", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.writeFileSync(path.join(projectPath, "raiken.config.json"), "{ not json");
        let findings = await scan();
        expect(findings.some((f) => f.rule === "raiken-config-invalid")).toBe(true);

        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ browser: { defaultBrowser: "netscape" } }),
        );
        findings = await scan();
        expect(findings.some((f) => f.rule === "raiken-config-invalid")).toBe(true);
    });

    it("flags an API key committed in raiken.config.json", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "deepseek", apiKey: "sk-test" } }),
        );
        const findings = await scan();
        expect(findings.some((f) => f.rule === "api-key-in-config")).toBe(true);
    });

    it("reports a fully healthy project with no findings", async () => {
        installPlaywrightPackage();
        installChromium();
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "package.json"),
            JSON.stringify({ scripts: { dev: "vite" } }),
        );
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            `export default {
                use: { baseURL: 'http://localhost:3000' },
                webServer: { command: 'npm run dev', url: 'http://localhost:3000' },
            };`,
        );
        const findings = await scan();
        expect(findings).toEqual([]);
    });

    it("flags a Node version outside the supported engines range", async () => {
        const findings = await scan({ nodeVersion: "24.18.1" });
        const finding = findings.find((f) => f.rule === "node-version-unsupported");
        expect(finding?.severity).toBe("error");
        expect(finding?.message).toContain("24.18.1");
        expect(finding?.suggestion).toContain("nvm use 22");
    });

    it("accepts Node versions inside the range without a finding", async () => {
        const findings = await scan({ nodeVersion: "22.12.0" });
        expect(findings.some((f) => f.rule === "node-version-unsupported")).toBe(false);
    });

    it("flags a broken native module with the loader error and the rebuild fix", async () => {
        const findings = await scan({
            probeNativeModule: () => {
                const error = new Error(
                    "The module 'better_sqlite3.node' was compiled against a different Node.js version",
                ) as NodeJS.ErrnoException;
                error.code = "ERR_DLOPEN_FAILED";
                throw error;
            },
        });
        const finding = findings.find((f) => f.rule === "native-module-broken");
        expect(finding?.severity).toBe("error");
        expect(finding?.message).toContain("ERR_DLOPEN_FAILED");
        expect(finding?.suggestion).toContain("pnpm rebuild better-sqlite3");
    });
});

describe("parseNodeEngines", () => {
    it("parses the supported >=X <Y shape into comparable bounds", () => {
        expect(parseNodeEngines(">=22 <23")).toEqual({ minMajor: 22, maxMajorExclusive: 23 });
        expect(parseNodeEngines(">= 18 < 21")).toEqual({ minMajor: 18, maxMajorExclusive: 21 });
    });

    it("returns null for shapes it does not understand", () => {
        expect(parseNodeEngines(">=22")).toBeNull();
        expect(parseNodeEngines("^20")).toBeNull();
        expect(parseNodeEngines("")).toBeNull();
    });
});
