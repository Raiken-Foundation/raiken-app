/**
 * Anti-pattern scanner for test files, powering `raiken doctor`.
 *
 * Philosophy: keep checks simple, cheap, and explainable. The goal is not
 * to replace ESLint — it is to catch the handful of patterns that reliably
 * produce flaky Playwright tests and that a dev can fix in seconds.
 *
 * Fixed sleeps (`page.waitForTimeout`, `setTimeout`) are responsible for
 * ~45% of async-wait flakes (Luo et al., FSE 2014), which is why we lead
 * with them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readPlaywrightBaseURL } from "../testing/playwright-config";
import { detectDevServerPort } from "../testing/port-detector";

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorFinding {
    rule: string;
    severity: DoctorSeverity;
    message: string;
    file: string;
    line: number;
    column: number;
    /** The matched source snippet (trimmed to a single line). */
    snippet: string;
    /** Short actionable suggestion. */
    suggestion: string;
}

export interface DoctorReport {
    scannedFiles: number;
    findings: DoctorFinding[];
    summary: {
        error: number;
        warning: number;
        info: number;
    };
}

export interface DoctorOptions {
    /** Absolute path to the project root. */
    projectPath: string;
    /** Test directory relative to `projectPath` (e.g. "e2e", "tests"). */
    testDirectory: string;
    /** Optional extra directories to scan. */
    extraDirectories?: string[];
    /** File extensions to consider. Default: .ts, .tsx, .js, .jsx, .mjs. */
    extensions?: string[];
}

interface Rule {
    id: string;
    severity: DoctorSeverity;
    /** Must be single-line (^/$ apply per line). */
    pattern: RegExp;
    message: string;
    suggestion: string;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Rules ordered by severity. Each pattern is matched once per line; the
 * first match on a line wins so we don't double-report obvious overlaps.
 */
const RULES: Rule[] = [
    {
        id: "no-wait-for-timeout",
        severity: "error",
        pattern: /\bpage\s*\.\s*waitForTimeout\s*\(/,
        message: "page.waitForTimeout is a fixed sleep and causes flakiness.",
        suggestion:
            "Prefer expect(locator).toBeVisible({ timeout }) / waitForURL / waitForResponse on the real condition.",
    },
    {
        id: "no-set-timeout",
        severity: "error",
        pattern: /\bsetTimeout\s*\(/,
        message: "setTimeout inside a test masks timing bugs with fixed sleeps.",
        suggestion:
            "Wait for an assertable condition (expect().toBeVisible, toHaveText) instead of sleeping.",
    },
    {
        id: "no-sleep",
        severity: "error",
        pattern: /\b(await\s+)?sleep\s*\(\s*\d+/,
        message: "Hand-rolled sleep() inside a test introduces flaky timing.",
        suggestion: "Replace with an explicit wait on the condition you actually care about.",
    },
    {
        id: "no-trivial-assertion",
        severity: "warning",
        pattern: /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
        message: "Trivial assertion (expect(true).toBe(true)).",
        suggestion: "Replace with an assertion tied to the feature under test.",
    },
    {
        id: "no-skip-always",
        severity: "warning",
        // Only flag the PERMANENT-skip forms:
        //   test.skip("name", fn)       ← suite-level skip
        //   test.skip()                 ← empty (skips the current test always)
        // The conditional form `test.skip(condition, 'reason')` inside a test
        // body is Playwright's idiomatic feature-gate and must NOT be flagged.
        pattern: /\btest\s*\.\s*skip\s*\(\s*(['"`]|\))/,
        message: 'test.skip("name", ...) / test.skip() disables the test permanently.',
        suggestion:
            "If the test is intentionally disabled, add a TODO with the reason and a ticket reference. For conditional gating use test.skip(condition, 'reason') inside the test body.",
    },
    {
        id: "no-only",
        severity: "warning",
        pattern: /\b(test|describe|it)\s*\.\s*only\s*\(/,
        message: ".only will silently drop every other test in the suite on CI.",
        suggestion: "Remove .only before committing.",
    },
    {
        id: "no-commented-url",
        severity: "info",
        // Matches: // await page.goto('http://...') — commented-out dev URLs.
        pattern: /^\s*\/\/\s*(?:await\s+)?page\.goto\(/,
        message: "Commented-out page.goto — likely a debug leftover.",
        suggestion: "Remove or convert to a real assertion.",
    },
];

/**
 * Per-line rule that only applies when the project has a Playwright
 * `baseURL` configured. Hardcoding `http://localhost:NNN` in tests defeats
 * the baseURL plumbing — the test won't follow the suite to staging/prod
 * without find-and-replace.
 *
 * Kept separate from {@link RULES} because the rule set depends on project
 * configuration, not just file content. Run only after we've decided the
 * project has a baseURL.
 */
const HARDCODED_LOCALHOST_RULE: Rule = {
    id: "hardcoded-localhost",
    severity: "info",
    // Match `http://localhost` or `https://localhost`, optionally with a
    // port. We don't restrict the surrounding context: anything from a
    // `page.goto`, `toHaveURL`, `request.get`, or even a constant
    // declaration counts. False positives (e.g. a localhost URL inside a
    // documentation string) are acceptable at info-severity.
    pattern: /https?:\/\/localhost(?::\d+)?/,
    message: "Hardcoded localhost URL ignores the configured Playwright baseURL.",
    suggestion:
        "Use a relative path like `page.goto('/login')` so the test runs against any baseURL (local, staging, prod).",
};

export async function scanTests(options: DoctorOptions): Promise<DoctorReport> {
    const exts = options.extensions ?? DEFAULT_EXTENSIONS;
    const projectPath = path.resolve(options.projectPath);

    const roots = [options.testDirectory, ...(options.extraDirectories ?? [])]
        .map((p) => path.resolve(projectPath, p))
        .filter((p) => fs.existsSync(p));

    const files = new Set<string>();
    for (const root of roots) collectFiles(root, exts, files);

    const findings: DoctorFinding[] = [];

    // Project-level checks: read playwright.config.ts once. We use the
    // detected baseURL to (a) flag mismatches with the dev-server port and
    // (b) decide whether to enable the per-file hardcoded-localhost rule.
    const projectFindings = await scanProjectConfig(projectPath);
    findings.push(...projectFindings.findings);
    const extraRules: Rule[] = projectFindings.baseURL ? [HARDCODED_LOCALHOST_RULE] : [];

    for (const absFile of files) {
        try {
            const text = fs.readFileSync(absFile, "utf-8");
            const rel = path.relative(projectPath, absFile);
            findings.push(...scanText(text, rel, extraRules));
        } catch {
            // Unreadable files are simply skipped; a crash here would be worse
            // than a silent miss for a lint-style tool.
        }
    }

    findings.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        if (a.line !== b.line) return a.line - b.line;
        return a.column - b.column;
    });

    const summary = { error: 0, warning: 0, info: 0 };
    for (const f of findings) summary[f.severity]++;

    return { scannedFiles: files.size, findings, summary };
}

interface ProjectScanResult {
    findings: DoctorFinding[];
    /** The `baseURL` literal extracted from the playwright config, if any. */
    baseURL: string | null;
}

/**
 * Project-level checks against `playwright.config.{ts,js,mjs,cjs}`:
 *
 *   - `baseurl-port-mismatch`: a `localhost:N` baseURL whose port disagrees
 *     with the detected dev-server port (vite/angular/package.json scripts).
 *     Misalignment here is the #1 cause of `webServer` timeouts and tests
 *     hitting a stale build instead of the dev server.
 *
 * Returns the resolved baseURL so per-file rules can branch on it.
 */
async function scanProjectConfig(projectPath: string): Promise<ProjectScanResult> {
    const configFile = findPlaywrightConfig(projectPath);
    const baseURL = await safeRead(() => readPlaywrightBaseURL(projectPath));

    if (!configFile || !baseURL) {
        return { findings: [], baseURL };
    }

    const findings: DoctorFinding[] = [];
    const localhostPortMatch = baseURL.match(/^https?:\/\/localhost:(\d+)/i);

    if (localhostPortMatch) {
        const baseURLPort = Number.parseInt(localhostPortMatch[1] ?? "", 10);
        const detectedPort = await safeRead(() => detectDevServerPort(projectPath, Number.NaN));

        if (
            Number.isInteger(detectedPort) &&
            !Number.isNaN(detectedPort) &&
            (detectedPort as number) !== baseURLPort
        ) {
            findings.push({
                rule: "baseurl-port-mismatch",
                severity: "warning",
                file: path.relative(projectPath, configFile),
                line: 1,
                column: 1,
                snippet: `baseURL: "${baseURL}"`,
                message: `Playwright baseURL points to port ${baseURLPort} but the detected dev server runs on port ${detectedPort}.`,
                suggestion: `Update use.baseURL to "http://localhost:${detectedPort}" (or align webServer.command/url with port ${baseURLPort}).`,
            });
        }
    }

    return { findings, baseURL };
}

function findPlaywrightConfig(projectPath: string): string | null {
    const candidates = [
        "playwright.config.ts",
        "playwright.config.mts",
        "playwright.config.js",
        "playwright.config.mjs",
        "playwright.config.cjs",
    ];
    for (const c of candidates) {
        const p = path.join(projectPath, c);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

async function safeRead<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch {
        return null;
    }
}

function collectFiles(dir: string, exts: string[], out: Set<string>): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            collectFiles(full, exts, out);
        } else if (entry.isFile()) {
            if (exts.some((ext) => entry.name.endsWith(ext))) out.add(full);
        }
    }
}

function scanText(text: string, file: string, extraRules: Rule[] = []): DoctorFinding[] {
    const findings: DoctorFinding[] = [];
    const lines = text.split(/\r?\n/);
    const allRules = [...RULES, ...extraRules];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // Ignore lines that start with a block-comment marker; avoids noise
        // from commented-out examples in fixtures/templates.
        if (/^\s*\*/.test(line)) continue;

        for (const rule of allRules) {
            const match = rule.pattern.exec(line);
            if (!match) continue;
            findings.push({
                rule: rule.id,
                severity: rule.severity,
                message: rule.message,
                suggestion: rule.suggestion,
                file,
                line: i + 1,
                column: (match.index ?? 0) + 1,
                snippet: line.trim().slice(0, 200),
            });
            break; // one finding per line
        }
    }
    return findings;
}
