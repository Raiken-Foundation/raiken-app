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
import { inspectAuthState } from "../config/auth-state";
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
    // ---- Selector-quality rules (Issue 7) ------------------------------------
    // All three selector rules anchor on the small set of Playwright APIs that
    // accept a CSS-engine string (locator, $, $$, click, fill, etc.). The
    // semantic queries — getByRole, getByLabel, getByTestId, getByText,
    // getByPlaceholder, getByAltText, getByTitle — are deliberately excluded
    // from the alternation so they never trigger these rules even if the user
    // happens to pass a string that LOOKS brittle (e.g. test-id "css-cta-1").
    //
    // Per-line `first match wins` means a selector that is brittle on multiple
    // axes (hash + nth-child + deep chain) still produces ONE finding — the
    // most specific signal first. Order below reflects that priority.
    {
        id: "no-css-in-js-hash",
        severity: "warning",
        // Matches MUI generated classes (MuiBox-root, MuiButton-contained...),
        // Emotion (css-1abc2de), styled-components (sc-jSUZER), styled-jsx
        // (jsx-1234567890), and CSS Modules (_button__a3f9d). These hashes
        // change on every CSS-in-JS bundle and are the #1 cause of post-deploy
        // selector breakage that doesn't surface in dev.
        pattern:
            /\.(?:click|locator|fill|hover|dblclick|check|uncheck|selectOption|type|press|tap|waitForSelector|focus|setInputFiles|\$\$?)\s*\(\s*['"`][^'"`\n]*?(?:Mui[A-Z]\w+-|\bcss-[a-z0-9]{4,}|\bsc-[A-Za-z0-9]{4,}|\bjsx-\d{6,}|\b_[A-Za-z0-9-]{3,}_[A-Za-z0-9]{4,})/,
        message:
            "Selector targets a CSS-in-JS hashed class (MUI / Emotion / styled-components / styled-jsx / CSS Modules).",
        suggestion:
            "These hashes change every build. Use getByRole / getByLabel / getByTestId, or add a stable data-testid to the component.",
    },
    {
        id: "no-deep-descendant-chain",
        severity: "warning",
        // 3+ direct-child combinators (>). Two-level chains (`#root > main`)
        // are pragmatic and survive most refactors; three+ are tightly
        // coupled to internal layout and break on any wrapper change.
        pattern:
            /\.(?:click|locator|fill|hover|dblclick|check|uncheck|selectOption|type|press|tap|waitForSelector|focus|setInputFiles|\$\$?)\s*\(\s*['"`][^'"`\n]*?>[^>'"`\n]*>[^>'"`\n]*>/,
        message: "Selector chains 3+ direct-child combinators (>). Brittle to layout changes.",
        suggestion:
            "Refactor to a stable role/label/test-id query (getByRole, getByLabel, getByTestId).",
    },
    {
        id: "prefer-role-selectors",
        severity: "info",
        // Positional selectors (:nth-child, :nth-of-type) couple the test to
        // the rendered order of siblings. Any reordering — sorting,
        // pagination, A/B test, new menu item — silently picks the wrong
        // element.
        pattern:
            /\.(?:click|locator|fill|hover|dblclick|check|uncheck|selectOption|type|press|tap|waitForSelector|focus|setInputFiles|\$\$?)\s*\(\s*['"`][^'"`\n]*?:nth-(?:child|of-type)\(/,
        message: "Positional CSS selector (:nth-child / :nth-of-type) is brittle to ordering.",
        suggestion:
            "Prefer a semantic query like getByRole('button', { name: 'Save' }) or getByLabel — it survives reordering.",
    },
    // -------------------------------------------------------------------------
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

/**
 * A `storageState` pointing at a file on disk, e.g.
 * `test.use({ storageState: ".raiken/auth-state.json" })`.
 *
 * Only a string literal counts. `storageState: { cookies: [], origins: [] }`
 * is Playwright's documented way to run ONE spec signed out despite a global
 * authenticated state — the opposite of the mistake below — and
 * `storageState: undefined` likewise. Neither must ever be flagged.
 */
const STORAGE_STATE_LITERAL = /storageState\s*:\s*(['"`])([^'"`]+)\1/;

/**
 * Steps that only make sense when the browser starts signed OUT.
 *
 * Deliberately narrow. A password field is NOT on this list: authenticated
 * apps ask for one all the time — reauthenticating before a destructive
 * action, changing a password — and the benchmark fixture's delete-workspace
 * flow does exactly that. Flagging it would turn a correct test into an
 * `error`-severity finding that fails `raiken doctor --fail-on error`.
 *
 * Navigating to a login route and pressing a control named "sign in" / "log
 * in" are the two signals that stay unambiguous, and a real login flow has at
 * least one of them.
 */
const LOGIN_SIGNALS: Array<{ pattern: RegExp; describe: string }> = [
    {
        pattern: /\.goto\(\s*['"`][^'"`]*\/(?:login|signin|sign-in|log-in|auth\/login)\b/i,
        describe: "navigates to the login page",
    },
    {
        pattern: /getByRole\(\s*['"`]button['"`]\s*,[^)]*(?:sign\s*in|log\s*in|login)/i,
        describe: "clicks the sign-in button",
    },
];

/**
 * Signing out first makes a later sign-in legitimate ("log out, log back in"
 * is a real flow), so a file containing one is left alone.
 */
const LOGOUT_SIGNAL = /(?:sign\s*out|signout|log\s*out|logout)/i;

function isCommentLine(line: string): boolean {
    return /^\s*(?:\*|\/\/)/.test(line);
}

/**
 * Auth-precondition consistency, checked across the whole file.
 *
 * The line-by-line rules above cannot catch this: `test.use({ storageState })`
 * on line 3 and a login form filled on line 40 are each perfectly valid on
 * their own, and only contradict each other in combination. That combination
 * is a guaranteed failure — the browser starts already signed in, the app
 * redirects away from the login page, and the spec times out hunting for
 * fields that were never rendered. Raiken generated exactly this spec for an
 * MFA prompt and `doctor` reported nothing.
 */
function scanAuthPreconditions(text: string, file: string, projectPath: string): DoctorFinding[] {
    const lines = text.split(/\r?\n/);

    let stateLine = 0;
    let statePath = "";
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || isCommentLine(line)) continue;
        const match = STORAGE_STATE_LITERAL.exec(line);
        if (match) {
            stateLine = i + 1;
            statePath = match[2];
            break;
        }
    }
    if (!statePath) return [];

    const snippet = lines[stateLine - 1].trim().slice(0, 200);
    const findings: DoctorFinding[] = [];

    if (!LOGOUT_SIGNAL.test(text)) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line || isCommentLine(line)) continue;
            const signal = LOGIN_SIGNALS.find((candidate) => candidate.pattern.test(line));
            if (!signal) continue;
            findings.push({
                rule: "auth-state-with-login-flow",
                severity: "error",
                file,
                line: stateLine,
                column: 1,
                snippet,
                message: `This spec loads a saved session (storageState: "${statePath}") but ${signal.describe} on line ${
                    i + 1
                } — it starts already signed in, so the login UI never appears.`,
                suggestion:
                    "Drop the storageState for this spec so it starts signed out (or use `storageState: { cookies: [], origins: [] }` to opt one spec out of a global authenticated state).",
            });
            break;
        }
    }

    // A path that isn't there is the same contradiction stated differently:
    // the spec claims a captured session that does not exist. Interpolated
    // paths are skipped — their value isn't knowable from the source.
    if (!/\$\{|process\.env/.test(snippet)) {
        const stateFile = path.isAbsolute(statePath)
            ? statePath
            : path.resolve(projectPath, statePath);
        const inspection = inspectAuthState(stateFile);
        if (inspection.status === "missing") {
            findings.push({
                rule: "missing-auth-state-file",
                severity: "warning",
                file,
                line: stateLine,
                column: 1,
                snippet,
                message: `storageState points at "${statePath}", which does not exist — every test in this file fails before its first step.`,
                suggestion:
                    "Capture a session with `raiken auth`, or point storageState at the file your setup project writes.",
            });
        } else if (inspection.status === "malformed") {
            findings.push({
                rule: "malformed-auth-state-file",
                severity: "warning",
                file,
                line: stateLine,
                column: 1,
                snippet,
                message: `storageState points at "${statePath}", but it is not a valid Playwright storage-state file.`,
                suggestion: "Replace it by capturing a fresh session with `raiken auth`.",
            });
        } else if (inspection.status === "empty") {
            findings.push({
                rule: "empty-auth-state-file",
                severity: "warning",
                file,
                line: stateLine,
                column: 1,
                snippet,
                message: `storageState points at "${statePath}", but it contains no cookies or origins.`,
                suggestion: "Sign in and capture a populated session with `raiken auth`.",
            });
        } else if (inspection.status === "expired") {
            findings.push({
                rule: "expired-auth-state-file",
                severity: "warning",
                file,
                line: stateLine,
                column: 1,
                snippet,
                message: `storageState points at "${statePath}", but all persistent cookies have expired.`,
                suggestion: "Refresh the saved session with `raiken auth`.",
            });
        }
    }

    return findings;
}

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
            findings.push(...scanAuthPreconditions(text, rel, projectPath));
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
