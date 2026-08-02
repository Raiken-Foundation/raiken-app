/**
 * Structured auto-fixes for the mechanical doctor findings that have a
 * one-shot remedy (widen testMatch, align baseURL port, add webServer).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { detectDevServerPort } from "../testing/port-detector";
import {
    findPlaywrightConfigPath,
    readPlaywrightBaseURL,
} from "../testing/playwright-config";
import type { DoctorFinding } from "./scan";
import { findWebServerRunScripts, readPackageScripts } from "./environment";

export type DoctorFixId = "widen-testmatch" | "align-baseurl-port" | "add-webserver";

export interface DoctorFixResult {
    rule: string;
    fixId: DoctorFixId;
    applied: boolean;
    message: string;
}

/** Rules that have a mechanical fix. */
export const FIXABLE_DOCTOR_RULES = new Set([
    "testmatch-restrictive",
    "baseurl-port-mismatch",
    "baseurl-unreachable",
]);

export function isFixableDoctorFinding(finding: DoctorFinding): boolean {
    return FIXABLE_DOCTOR_RULES.has(finding.rule);
}

export function doctorFixLabel(rule: string): string {
    switch (rule) {
        case "testmatch-restrictive":
            return 'Widen testMatch to ["**/*.spec.ts"]';
        case "baseurl-port-mismatch":
            return "Align baseURL with the detected dev-server port";
        case "baseurl-unreachable":
            return "Add a webServer block from the package.json dev script";
        default:
            return `Fix ${rule}`;
    }
}

async function readConfigText(projectPath: string): Promise<{
    configPath: string;
    text: string;
} | null> {
    const configPath = await findPlaywrightConfigPath(projectPath);
    if (!configPath) return null;
    try {
        return { configPath, text: fs.readFileSync(configPath, "utf-8") };
    } catch {
        return null;
    }
}

/** Widen a restrictive testMatch to the permissive Playwright default. */
export async function applyWidenTestMatch(projectPath: string): Promise<DoctorFixResult> {
    const loaded = await readConfigText(projectPath);
    if (!loaded) {
        return {
            rule: "testmatch-restrictive",
            fixId: "widen-testmatch",
            applied: false,
            message: "No playwright.config found to update.",
        };
    }

    let next = loaded.text;
    if (/testMatch\s*:\s*\[/.test(next)) {
        next = next.replace(/testMatch\s*:\s*\[[\s\S]*?\]/, 'testMatch: ["**/*.spec.ts"]');
    } else if (/testMatch\s*:\s*(['"`])[^'"`\n]+\1/.test(next)) {
        next = next.replace(
            /testMatch\s*:\s*(['"`])[^'"`\n]+\1/,
            'testMatch: ["**/*.spec.ts"]',
        );
    } else {
        // Insert under use: or at top-level export default.
        if (/export\s+default\s+\{/.test(next)) {
            next = next.replace(
                /export\s+default\s+\{/,
                'export default {\n  testMatch: ["**/*.spec.ts"],',
            );
        } else {
            return {
                rule: "testmatch-restrictive",
                fixId: "widen-testmatch",
                applied: false,
                message: "Could not locate a place to write testMatch.",
            };
        }
    }

    if (next === loaded.text) {
        return {
            rule: "testmatch-restrictive",
            fixId: "widen-testmatch",
            applied: false,
            message: "testMatch already looks permissive or could not be rewritten.",
        };
    }

    fs.writeFileSync(loaded.configPath, next, "utf-8");
    return {
        rule: "testmatch-restrictive",
        fixId: "widen-testmatch",
        applied: true,
        message: `Updated ${path.relative(projectPath, loaded.configPath)}: testMatch → ["**/*.spec.ts"]`,
    };
}

/** Rewrite localhost baseURL to the detected port. */
export async function applyAlignBaseUrlPort(projectPath: string): Promise<DoctorFixResult> {
    const loaded = await readConfigText(projectPath);
    const baseURL = await readPlaywrightBaseURL(projectPath).catch(() => null);
    if (!loaded || !baseURL) {
        return {
            rule: "baseurl-port-mismatch",
            fixId: "align-baseurl-port",
            applied: false,
            message: "No baseURL found to rewrite.",
        };
    }

    const match = baseURL.match(/^(https?:\/\/localhost:)(\d+)(.*)$/i);
    if (!match) {
        return {
            rule: "baseurl-port-mismatch",
            fixId: "align-baseurl-port",
            applied: false,
            message: "baseURL is not a localhost URL.",
        };
    }

    const detected = await detectDevServerPort(projectPath, Number.NaN).catch(() => Number.NaN);
    if (!Number.isInteger(detected) || Number.isNaN(detected)) {
        return {
            rule: "baseurl-port-mismatch",
            fixId: "align-baseurl-port",
            applied: false,
            message: "Could not detect a dev-server port to align with.",
        };
    }

    const nextUrl = `${match[1]}${detected}${match[3] ?? ""}`;
    const next = loaded.text.replace(
        /baseURL\s*:\s*(["'`])([^"'`\n]+)\1/,
        `baseURL: $1${nextUrl}$1`,
    );
    if (next === loaded.text) {
        return {
            rule: "baseurl-port-mismatch",
            fixId: "align-baseurl-port",
            applied: false,
            message: "baseURL rewrite made no change.",
        };
    }

    fs.writeFileSync(loaded.configPath, next, "utf-8");
    return {
        rule: "baseurl-port-mismatch",
        fixId: "align-baseurl-port",
        applied: true,
        message: `Updated baseURL to ${nextUrl}`,
    };
}

/**
 * When baseURL is unreachable and there is no webServer, insert a webServer
 * block for the first known package.json script (dev/start/serve).
 */
export async function applyAddWebServer(projectPath: string): Promise<DoctorFixResult> {
    const loaded = await readConfigText(projectPath);
    if (!loaded) {
        return {
            rule: "baseurl-unreachable",
            fixId: "add-webserver",
            applied: false,
            message: "No playwright.config found.",
        };
    }

    if (/webServer\s*:/.test(loaded.text)) {
        return {
            rule: "baseurl-unreachable",
            fixId: "add-webserver",
            applied: false,
            message: "A webServer block already exists (possibly commented out).",
        };
    }

    const pkgScripts = readPackageScripts(projectPath);
    const script =
        (["dev", "start", "serve", "preview"] as const).find((name) => name in pkgScripts) ?? null;
    if (!script) {
        return {
            rule: "baseurl-unreachable",
            fixId: "add-webserver",
            applied: false,
            message: "package.json has no dev/start/serve script to wire as webServer.",
        };
    }

    const baseURL =
        (await readPlaywrightBaseURL(projectPath).catch(() => null)) ?? "http://localhost:3000";
    const block = `  webServer: {\n    command: 'npm run ${script}',\n    url: '${baseURL}',\n    reuseExistingServer: !process.env.CI,\n  },`;

    let next: string;
    if (/export\s+default\s+\{/.test(loaded.text)) {
        next = loaded.text.replace(/export\s+default\s+\{/, `export default {\n${block}`);
    } else {
        return {
            rule: "baseurl-unreachable",
            fixId: "add-webserver",
            applied: false,
            message: "Could not locate export default { to insert webServer.",
        };
    }

    // Sanity: don't invent a command that findWebServerRunScripts can't see.
    if (!findWebServerRunScripts(next).includes(script)) {
        return {
            rule: "baseurl-unreachable",
            fixId: "add-webserver",
            applied: false,
            message: "Inserted webServer but script name was not parseable.",
        };
    }

    fs.writeFileSync(loaded.configPath, next, "utf-8");
    return {
        rule: "baseurl-unreachable",
        fixId: "add-webserver",
        applied: true,
        message: `Added webServer for \`npm run ${script}\` → ${baseURL}`,
    };
}

/** Apply the fix for a single finding when one exists. */
export async function applyDoctorFix(
    projectPath: string,
    finding: DoctorFinding,
): Promise<DoctorFixResult> {
    switch (finding.rule) {
        case "testmatch-restrictive":
            return applyWidenTestMatch(projectPath);
        case "baseurl-port-mismatch":
            return applyAlignBaseUrlPort(projectPath);
        case "baseurl-unreachable":
            return applyAddWebServer(projectPath);
        default:
            return {
                rule: finding.rule,
                fixId: "widen-testmatch",
                applied: false,
                message: `No automatic fix for rule ${finding.rule}.`,
            };
    }
}

/** Apply every fixable finding once (deduped by rule). */
export async function applyDoctorFixes(
    projectPath: string,
    findings: DoctorFinding[],
): Promise<DoctorFixResult[]> {
    const seen = new Set<string>();
    const results: DoctorFixResult[] = [];
    for (const finding of findings) {
        if (!isFixableDoctorFinding(finding) || seen.has(finding.rule)) continue;
        seen.add(finding.rule);
        results.push(await applyDoctorFix(projectPath, finding));
    }
    return results;
}
