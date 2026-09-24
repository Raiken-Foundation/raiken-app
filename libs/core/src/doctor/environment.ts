/**
 * Environment checks for `raiken doctor` — the brew-doctor half of the
 * command. The anti-pattern scanner lints specs; this verifies the machine
 * can actually run them: Playwright present, browsers downloaded, the
 * webServer script the config points at really exists, and (when Playwright
 * won't start the app itself) the baseURL answers.
 *
 * Every check is filesystem- or schema-based except the baseURL probe,
 * which only fires when the config has no `webServer` block (otherwise
 * Playwright starts the app and an unreachable URL is expected).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { raikenConfigSchema } from "../config/schema";
import { getConfigPath } from "../config/store";
import { isRestrictiveTestMatch } from "../cover/draft-quality";
import {
    findPlaywrightConfigPath,
    readPlaywrightBaseURL,
    readPlaywrightTestMatch,
} from "../testing/playwright-config";
import type { DoctorFinding } from "./scan";

export interface EnvironmentScanOptions {
    /** Absolute project root. */
    projectPath: string;
    /** Test directory relative to projectPath (for the missing-dir check). */
    testDirectory?: string;
    /** Injectable baseURL probe (tests); defaults to a 1.5s HTTP GET. */
    probeUrl?: (url: string) => Promise<boolean>;
    /** Injectable environment (tests read PLAYWRIGHT_BROWSERS_PATH). */
    env?: NodeJS.ProcessEnv;
    /** Injectable home directory for the browser-cache resolution (tests). */
    homeDir?: string;
}

const ENV_FILE = "(environment)";

/** Rule ids produced by {@link scanEnvironment} — lets UIs section them off. */
export const ENVIRONMENT_RULES: ReadonlySet<string> = new Set([
    "api-key-in-config",
    "playwright-package-missing",
    "playwright-browsers-missing",
    "raiken-config-invalid",
    "webserver-script-missing",
    "baseurl-unreachable",
    "playwright-config-missing",
    "test-directory-missing",
    "testmatch-restrictive",
]);

function finding(
    partial: Pick<DoctorFinding, "rule" | "severity" | "message" | "suggestion"> &
        Partial<DoctorFinding>,
): DoctorFinding {
    return {
        file: ENV_FILE,
        line: 0,
        column: 0,
        snippet: "",
        ...partial,
    };
}

/**
 * Remove `//` line comments and `/* *\/` block comments from config source
 * while leaving string/template contents untouched (a naive line-regex would
 * mangle `command: 'http://localhost:3000'`). Doctor scans raw config text;
 * without this, a commented-out webServer block reads as a real one.
 * Exported for unit tests.
 */
export function stripConfigComments(source: string): string {
    let out = "";
    let i = 0;
    type State = "code" | "single" | "double" | "template" | "line" | "block";
    let state: State = "code";
    while (i < source.length) {
        const ch = source[i] as string;
        const next = source[i + 1];
        if (state === "line") {
            if (ch === "\n") {
                state = "code";
                out += ch;
            }
        } else if (state === "block") {
            if (ch === "*" && next === "/") {
                state = "code";
                i++;
            } else if (ch === "\n") {
                // Keep newlines so line numbers in the stripped text still
                // line up with the original file.
                out += ch;
            }
        } else if (state === "single") {
            out += ch;
            if (ch === "\\") {
                if (i + 1 < source.length) out += source[++i];
            } else if (ch === "'") {
                state = "code";
            }
        } else if (state === "double") {
            out += ch;
            if (ch === "\\") {
                if (i + 1 < source.length) out += source[++i];
            } else if (ch === '"') {
                state = "code";
            }
        } else if (state === "template") {
            out += ch;
            if (ch === "\\") {
                if (i + 1 < source.length) out += source[++i];
            } else if (ch === "`") {
                state = "code";
            }
        } else {
            if (ch === "/" && next === "/") {
                state = "line";
                i++;
            } else if (ch === "/" && next === "*") {
                state = "block";
                i++;
            } else {
                out += ch;
                if (ch === "'") state = "single";
                else if (ch === '"') state = "double";
                else if (ch === "`") state = "template";
            }
        }
        i++;
    }
    return out;
}

/**
 * Extract `npm run <script>` / `pnpm <script>` / `yarn <script>` names from
 * webServer command entries in playwright.config source text. Comments are
 * stripped first so a commented-out block can't produce phantom scripts.
 * Exported for unit tests.
 */
export function findWebServerRunScripts(configText: string): string[] {
    const scripts = new Set<string>();
    const pattern = /(?:npm\s+run|pnpm(?:\s+run)?|yarn)\s+([A-Za-z0-9:_-]+)/g;
    const codeText = stripConfigComments(configText);
    for (let match = pattern.exec(codeText); match !== null; match = pattern.exec(codeText)) {
        scripts.add(match[1] as string);
    }
    return [...scripts];
}

/** Scripts declared by the project's package.json (empty when unreadable). */
export function readPackageScripts(projectPath: string): Record<string, string> {
    try {
        const raw = JSON.parse(
            fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"),
        ) as { scripts?: Record<string, string> };
        return raw.scripts ?? {};
    } catch {
        return {};
    }
}

/**
 * Resolve the directory Playwright downloads browsers into. Returns null
 * when browsers are vendored inside the package (PLAYWRIGHT_BROWSERS_PATH=0)
 * — the caller then checks the package-local path instead.
 */
export function resolvePlaywrightBrowsersPath(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    homeDir: string,
): string {
    const override = env["PLAYWRIGHT_BROWSERS_PATH"];
    if (override && override !== "0") return override;
    if (override === "0") return path.join("node_modules", "playwright-core", ".local-browsers");
    if (platform === "win32") {
        return path.join(env["USERPROFILE"] ?? homeDir, "AppData", "Local", "ms-playwright");
    }
    if (platform === "darwin") {
        return path.join(homeDir, "Library", "Caches", "ms-playwright");
    }
    return path.join(env["XDG_CACHE_HOME"] ?? path.join(homeDir, ".cache"), "ms-playwright");
}

/** True when a chromium build (headed or headless-shell) exists in the cache. */
export function hasChromiumBrowser(browsersPath: string): boolean {
    try {
        return fs
            .readdirSync(browsersPath, { withFileTypes: true })
            .some((entry) => entry.isDirectory() && /^chromium([_-]|$)/.test(entry.name));
    } catch {
        return false;
    }
}

function defaultProbeUrl(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const client = url.startsWith("https:") ? https : http;
        const request = client.get(url, { timeout: 1500 }, (response) => {
            response.resume();
            resolve(true);
        });
        request.on("timeout", () => {
            request.destroy();
            resolve(false);
        });
        request.on("error", () => resolve(false));
    });
}

export async function scanEnvironment(options: EnvironmentScanOptions): Promise<DoctorFinding[]> {
    const projectPath = path.resolve(options.projectPath);
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    const findings: DoctorFinding[] = [];

    // 1. Playwright package present — pure fs so npx never auto-installs
    //    anything as a side effect of a lint command.
    const localPackage = ["@playwright/test", "playwright", "playwright-core"].some((pkg) =>
        fs.existsSync(path.join(projectPath, "node_modules", pkg, "package.json")),
    );
    if (!localPackage) {
        findings.push(
            finding({
                rule: "playwright-package-missing",
                severity: "error",
                file: "package.json",
                line: 1,
                column: 1,
                message: "Playwright is not installed in this project.",
                suggestion:
                    "Install it with `npm i -D @playwright/test` (or run `raiken init` to set up everything).",
            }),
        );
    }

    // 2. Chromium binary downloaded. A missing browser turns the first test
    //    run into "Executable doesn't exist" — catch it before that.
    const browsersPath = resolvePlaywrightBrowsersPath(env, process.platform, homeDir);
    const browsersBase = browsersPath.startsWith("node_modules")
        ? path.join(projectPath, browsersPath)
        : browsersPath;
    if (localPackage && !hasChromiumBrowser(browsersBase)) {
        findings.push(
            finding({
                rule: "playwright-browsers-missing",
                severity: "error",
                message: "No chromium build found in the Playwright browser cache.",
                snippet: browsersBase,
                suggestion:
                    "Run `npx playwright install chromium` (or `raiken init` without --skip-browsers).",
            }),
        );
    }

    // 3. raiken.config.json present but unreadable/invalid.
    const configPath = getConfigPath(projectPath);
    const configFileName = path.basename(configPath);
    if (fs.existsSync(configPath)) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        } catch {
            findings.push(
                finding({
                    rule: "raiken-config-invalid",
                    severity: "error",
                    file: configFileName,
                    line: 1,
                    column: 1,
                    message: `${configFileName} is not valid JSON.`,
                    suggestion: "Fix the syntax error, or regenerate with `raiken init --force`.",
                }),
            );
        }
        if (parsed !== null) {
            const result = raikenConfigSchema.safeParse(parsed);
            if (!result.success) {
                const issue = result.error.issues[0];
                findings.push(
                    finding({
                        rule: "raiken-config-invalid",
                        severity: "error",
                        file: configFileName,
                        line: 1,
                        column: 1,
                        message: `${configFileName} failed validation: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown error"}.`,
                        suggestion:
                            "Fix the field above, or regenerate with `raiken init --force`.",
                    }),
                );
            }

            // Committed API keys are a secret leak, not a config choice. Flag
            // any non-empty key stored in the config file; the supported place
            // for a key is the environment or a gitignored .env.
            const rawConfig = parsed as Record<string, unknown>;
            const aiBlock = (rawConfig["ai"] ?? {}) as Record<string, unknown>;
            const apiKeysBlock = (rawConfig["apiKeys"] ?? {}) as Record<string, unknown>;
            const committedKeys: string[] = [];
            const aiKey = aiBlock["apiKey"];
            if (typeof aiKey === "string" && aiKey.trim()) {
                committedKeys.push("ai.apiKey");
            }
            if (apiKeysBlock && typeof apiKeysBlock === "object") {
                for (const [provider, key] of Object.entries(apiKeysBlock)) {
                    if (typeof key === "string" && key.trim())
                        committedKeys.push(`apiKeys.${provider}`);
                }
            }
            if (committedKeys.length > 0) {
                findings.push(
                    finding({
                        rule: "api-key-in-config",
                        severity: "warning",
                        file: configFileName,
                        line: 1,
                        column: 1,
                        message: `${configFileName} stores an API key (${committedKeys.join(", ")}). A key committed to version control is a secret leak.`,
                        suggestion:
                            "Remove the key and set the provider's env var (e.g. DEEPSEEK_API_KEY) or a gitignored .env — and revoke any key that was committed.",
                    }),
                );
            }
        }
    }

    // 4. Playwright config + the script its webServer block points at.
    const playwrightConfigPath = await findPlaywrightConfigPath(projectPath);
    if (!playwrightConfigPath) {
        findings.push(
            finding({
                rule: "playwright-config-missing",
                severity: "warning",
                message: "No playwright.config.ts found in the project root.",
                suggestion: "Run `raiken init` to scaffold one (it also sets an example spec).",
            }),
        );
    } else {
        let configText = "";
        try {
            configText = fs.readFileSync(playwrightConfigPath, "utf-8");
        } catch {
            // Unreadable config — the run itself will surface that.
        }
        const configRel = path.relative(projectPath, playwrightConfigPath);
        const scripts = findWebServerRunScripts(configText);
        if (scripts.length > 0) {
            const pkgScripts = readPackageScripts(projectPath);
            for (const script of scripts) {
                if (!(script in pkgScripts)) {
                    findings.push(
                        finding({
                            rule: "webserver-script-missing",
                            severity: "error",
                            file: configRel,
                            line: 1,
                            column: 1,
                            snippet: `webServer.command: "npm run ${script}"`,
                            message: `playwright.config starts the app with \`npm run ${script}\` but package.json has no "${script}" script — every run dies before executing a spec.`,
                            suggestion: `Add a "${script}" script to package.json (e.g. your dev server), or point webServer.command at an existing script.`,
                        }),
                    );
                }
            }
        }

        const testMatch = await readPlaywrightTestMatch(projectPath).catch(() => null);
        if (isRestrictiveTestMatch(testMatch)) {
            findings.push(
                finding({
                    rule: "testmatch-restrictive",
                    severity: "warning",
                    file: configRel,
                    line: 1,
                    column: 1,
                    snippet: `testMatch: ${JSON.stringify(testMatch)}`,
                    message:
                        "playwright.config testMatch is narrow — drafts named *.spec.ts may not run (`No tests found`).",
                    suggestion:
                        'Widen to `testMatch: ["**/*.spec.ts"]`, or write new specs under the collected basename.',
                }),
            );
        }

        // 5. baseURL reachability — only when Playwright will NOT start the
        //    app itself (no webServer block), otherwise unreachable is normal.
        //    Scan comment-stripped text: `raiken init` comments the webServer
        //    block out when there's no dev script, and that must not count.
        if (configText && !/webServer\s*:/.test(stripConfigComments(configText))) {
            const baseURL = await readPlaywrightBaseURL(projectPath).catch(() => null);
            if (baseURL && /^https?:\/\//.test(baseURL)) {
                const probe = options.probeUrl ?? defaultProbeUrl;
                const reachable = await probe(baseURL).catch(() => false);
                if (!reachable) {
                    findings.push(
                        finding({
                            rule: "baseurl-unreachable",
                            severity: "warning",
                            file: configRel,
                            line: 1,
                            column: 1,
                            snippet: `baseURL: "${baseURL}"`,
                            message: `${baseURL} did not answer and playwright.config has no webServer block to start it — tests will fail at the first page.goto.`,
                            suggestion:
                                "Start your app before running tests, or add a webServer block so Playwright boots it automatically.",
                        }),
                    );
                }
            }
        }
    }

    // 6. Test directory present.
    const testDirectory = options.testDirectory;
    if (testDirectory && !fs.existsSync(path.join(projectPath, testDirectory))) {
        findings.push(
            finding({
                rule: "test-directory-missing",
                severity: "warning",
                message: `Test directory "${testDirectory}/" does not exist.`,
                suggestion:
                    "Create it, update testDirectory in raiken.config.json, or run `raiken init`.",
            }),
        );
    }

    return findings;
}
