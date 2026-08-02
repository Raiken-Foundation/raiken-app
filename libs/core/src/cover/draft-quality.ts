/**
 * Cover-specific draft gates: Playwright config fit + structural validity
 * wrapping the shared {@link validateTestCode} parser.
 */

import * as path from "node:path";
import {
    findPlaywrightConfigPath,
    readPlaywrightTestDir,
    readPlaywrightTestMatch,
} from "../testing/playwright-config";
import { validateTestCode } from "../testing/test-code-validation";

export interface DraftStructureAssessment {
    ok: boolean;
    reason?: string;
}

/** Parse + require a real Playwright test() call. */
export function assessDraftStructure(body: string): DraftStructureAssessment {
    const validation = validateTestCode(body);
    if (validation.ok) return { ok: true };
    return { ok: false, reason: validation.reason ?? "invalid test draft" };
}

/**
 * True when `relativePath` (project-relative, forward slashes) matches a
 * Playwright `testMatch` glob. Supports `*`, `**`, and basename-only patterns
 * Playwright accepts (e.g. `workflows.spec.ts`).
 */
export function matchesPlaywrightTestPattern(relativePath: string, pattern: string): boolean {
    const file = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const base = path.posix.basename(file);
    const pat = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pat.includes("*") && !pat.includes("?") && !pat.includes("/")) {
        return base === pat || file === pat || file.endsWith(`/${pat}`);
    }
    const toRegex = (glob: string): RegExp => {
        const escaped = glob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, "§§")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")
            .replace(/§§/g, ".*");
        return new RegExp(`^${escaped}$`);
    };
    const re = toRegex(pat);
    return re.test(file) || re.test(base);
}

export interface AssertionPolarityAssessment {
    total: number;
    negative: number;
    /** True when every assertion in the draft asserts an absence. */
    allNegative: boolean;
    reason?: string;
}

/**
 * Flag a draft whose assertions only ever check that something is ABSENT.
 *
 * An absence assertion passes on a blank page, a 404, a login redirect, or an
 * app that never booted — so a suite of them is green by construction and
 * proves nothing. It is also the shape a model falls into when it cannot find
 * the thing it was asked to verify: asked to assert text is visible, it writes
 * `.not.toBeVisible()` and reports a pass, quietly inverting the request.
 *
 * A negative assertion alongside a positive one is normal and fine (delete a
 * row, then assert it's gone), so only an all-negative draft is flagged.
 */
export function assessAssertionPolarity(body: string): AssertionPolarityAssessment {
    const assertions = [
        ...body.matchAll(/\bexpect\s*\(([\s\S]*?)\)\s*(\.[\s\S]{0,120}?)(?=;|\n)/g),
    ];
    const NEGATIVE = /\.not\.|toHaveCount\s*\(\s*0\s*\)|toBeHidden\s*\(/;
    let negative = 0;
    for (const assertion of assertions) {
        if (NEGATIVE.test(assertion[2] ?? "")) negative += 1;
    }
    const total = assertions.length;
    const allNegative = total > 0 && negative === total;
    return {
        total,
        negative,
        allNegative,
        ...(allNegative
            ? {
                  reason:
                      `all ${total} assertion(s) check for absence (.not / toHaveCount(0) / toBeHidden) — ` +
                      "these also pass on a blank page, a redirect, or an app that never loaded, so confirm " +
                      "the draft is not inverting what was asked",
              }
            : {}),
    };
}

export interface PlaywrightFitAssessment {
    /** Absolute path of the Playwright config, when one exists. */
    configPath: string | null;
    testDir: string | null;
    testMatch: string[] | null;
    /**
     * False when a restrictive testMatch is configured and this output path
     * would not be collected by `playwright test`.
     */
    collectedByConfig: boolean;
    reason?: string;
}

/**
 * Check whether a draft written to `outputPath` would be picked up by the
 * project's Playwright config. Missing config → assume collected (Playwright
 * defaults). Empty/absent testMatch → collected.
 */
export async function assessPlaywrightFit(
    projectPath: string,
    outputPath: string,
): Promise<PlaywrightFitAssessment> {
    const configPath = await findPlaywrightConfigPath(projectPath);
    if (!configPath) {
        return {
            configPath: null,
            testDir: null,
            testMatch: null,
            collectedByConfig: true,
        };
    }

    const testDir = await readPlaywrightTestDir(projectPath);
    const testMatch = await readPlaywrightTestMatch(projectPath);
    const relative = path.relative(projectPath, outputPath).split(path.sep).join("/");

    if (!testMatch || testMatch.length === 0) {
        return {
            configPath,
            testDir,
            testMatch,
            collectedByConfig: true,
        };
    }

    // Playwright matches testMatch against paths relative to testDir, and
    // also accepts basename-only patterns. Check both forms.
    const underTestDir =
        testDir && relative.startsWith(`${testDir.replace(/\\/g, "/").replace(/\/$/, "")}/`)
            ? relative.slice(testDir.replace(/\\/g, "/").replace(/\/$/, "").length + 1)
            : relative;
    const candidates = [relative, underTestDir, path.posix.basename(relative)];
    const matched = testMatch.some((pattern) =>
        candidates.some((candidate) => matchesPlaywrightTestPattern(candidate, pattern)),
    );

    if (matched) {
        return { configPath, testDir, testMatch, collectedByConfig: true };
    }

    return {
        configPath,
        testDir,
        testMatch,
        collectedByConfig: false,
        reason: `${path.posix.basename(relative)} will not be collected: ${describeTestMatchRemedy(
            testMatch,
        )}`,
    };
}

/**
 * Explain a testMatch miss to someone who has never configured Playwright.
 *
 * "update testMatch or write under a matching name" assumes the reader knows
 * what testMatch is, where it lives, and what a safe value looks like — the
 * exact knowledge a first-week QA doesn't have, which turns a one-line config
 * fix into a dead end. Name the commands instead.
 */
export function describeTestMatchRemedy(patterns: string[] | null | undefined): string {
    const shown = (patterns ?? []).map((pattern) => JSON.stringify(pattern)).join(", ");
    const only = patterns?.length === 1 ? patterns[0] : undefined;
    const rename = only && !/[*?/\\]/.test(only) ? `, or save the spec as ${only}` : "";
    return (
        `Playwright only runs files matching testMatch (${shown || "none"}) in playwright.config, ` +
        `so this spec is never collected. Widen it with \`raiken doctor --fix\`${rename}.`
    );
}

/**
 * When the project's `testMatch` is a single basename (e.g. `workflows.spec.ts`)
 * and the desired default path would not be collected, steer to that basename
 * under the test directory so daily cover/test does not hit "No tests found".
 *
 * Returns null when steering is not safe (globs, multiple patterns, or the
 * desired path already matches).
 */
export async function suggestCollectedOutputPath(
    projectPath: string,
    desiredOutputPath: string,
): Promise<{ path: string; basename: string } | null> {
    const fit = await assessPlaywrightFit(projectPath, desiredOutputPath);
    if (fit.collectedByConfig) return null;
    const patterns = fit.testMatch ?? [];
    if (patterns.length !== 1) return null;
    const only = patterns[0] ?? "";
    // Basename-only patterns have no wildcards and no directory separators.
    if (!only || /[*?]/.test(only) || only.includes("/") || only.includes("\\")) return null;
    const dir = fit.testDir
        ? path.resolve(projectPath, fit.testDir)
        : path.dirname(desiredOutputPath);
    return { path: path.join(dir, only), basename: only };
}

/** True when testMatch is restrictive enough that typical `*.spec.ts` drafts miss it. */
export function isRestrictiveTestMatch(patterns: string[] | null | undefined): boolean {
    if (!patterns || patterns.length === 0) return false;
    const permissive = patterns.some(
        (pattern) =>
            pattern === "**/*.spec.ts" ||
            pattern === "**/*.{spec,test}.ts" ||
            pattern === "*.spec.ts" ||
            /\*\*\/\*\.spec\.(t|j)sx?$/.test(pattern.replace(/\\/g, "/")),
    );
    return !permissive;
}
