/**
 * Types for the `raiken ci` pipeline.
 *
 * The CI pipeline is a headless version of the sync workflow: it diffs the
 * current branch against a base ref, asks GraphQueryService which tests are
 * affected, runs them, and writes JUnit + JSON reports for the host (GitHub
 * Actions, GitLab CI, etc.) to consume.
 */

import type { AffectReason } from "../analysis/graph-query";
import type { TestRunResult } from "../testing/runner";

/** Status of a file in the base..head diff. */
export type CiChangedFileStatus = "added" | "modified" | "removed" | "renamed" | "copied";

/**
 * A single file in the base..head diff. Named with the `Ci` prefix to avoid
 * clashing with the richer `ChangedFile` used by the ticket integrations.
 */
export interface CiChangedFile {
    path: string;
    status: CiChangedFileStatus;
    /** Present only for renames / copies. */
    previousPath?: string;
}

export interface ResolvedRefs {
    /** User-provided (or defaulted) base ref label, e.g. "origin/main". */
    base: string;
    /** Resolved SHA for the base ref. */
    baseSha: string;
    /** User-provided (or defaulted) head ref label, e.g. "HEAD". */
    head: string;
    /** Resolved SHA for the head ref. */
    headSha: string;
}

/**
 * A single test file flagged as affected by the diff, with its evidence.
 * Serialised into `impact.json`.
 */
export interface CiAffectedTest {
    testFile: string;
    /** 0..1 aggregated confidence from the strongest contributing reason. */
    confidence: number;
    sourceFiles: string[];
    reasons: Array<{
        reason: AffectReason;
        provenance: "manual" | "static_ast" | "runtime" | "inferred";
        confidence: number;
        sourceFile: string;
        sourceSymbol?: string;
        targetSymbol?: string;
        line?: number;
        snippet?: string;
    }>;
}

export interface CiImpactReport {
    schemaVersion: 1;
    generatedAt: string;
    refs: ResolvedRefs;
    changedFiles: CiChangedFile[];
    /** Changed files that Playwright-style tests could depend on. */
    consideredSourceFiles: string[];
    affectedTests: CiAffectedTest[];
    /** Tests dropped because their confidence was below the threshold. */
    skippedBelowThreshold: Array<{ testFile: string; confidence: number }>;
    confidenceThreshold: number;
    /** How the test set was chosen, and why — never silently empty. */
    selection: CiSelection;
}

/**
 * How `raiken ci` chose what to run.
 *   impact — every changed source file is connected to at least one test
 *   full   — impact could not be proven (unmapped change, global file, or no
 *            code graph), so the whole suite runs
 *   none   — no source files changed; nothing needs to run
 */
export interface CiSelection {
    mode: "impact" | "full" | "none";
    reason: string;
    graph: { available: boolean; reason?: string };
    /** Changed source files no evidence connects to a test. */
    unmapped: string[];
}

/**
 * Aggregated outcome of actually running the affected tests. Serialised
 * into `results.json`. When `--skip-run` is used, `tests` is empty and
 * `ran` is false.
 */
export interface CiRunReport {
    schemaVersion: 1;
    ran: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    tests: TestRunResult[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        timedOut: number;
        errored: number;
    };
}

export interface CiOptions {
    projectPath: string;
    /** Base git ref (branch, tag, or SHA). Default: auto-detected. */
    base?: string;
    /** Head git ref. Default: "HEAD". */
    head?: string;
    /** Directory for emitted reports. Default: `.raiken/ci`. */
    outputDir?: string;
    /** Which report formats to emit. Default: `both`. */
    format?: "junit" | "json" | "both";
    /** Minimum confidence (0..1) for a test to be considered affected. */
    confidenceThreshold?: number;
    /** Hard cap on the number of affected tests executed. */
    maxTests?: number;
    /** Per-test timeout in ms. Default: 60_000. */
    testTimeout?: number;
    /**
     * When the impact of a change cannot be proven: run the full suite
     * ("full", default) or only the changed specs ("none").
     */
    fallback?: "full" | "none";
    /** If true, compute impact but do not actually run tests. */
    skipRun?: boolean;
    /**
     * If true, analyse the staged working-tree snapshot (`git diff --cached`)
     * instead of a ref range. Used by `raiken ci --staged` in pre-commit hooks.
     * When set, `base` / `head` are ignored.
     */
    staged?: boolean;
    /** Log progress events. Set by the CLI. */
    onEvent?: (event: CiEvent) => void;
}

export type CiEvent =
    | { type: "refs_resolved"; refs: ResolvedRefs }
    | { type: "diff_complete"; changedFiles: CiChangedFile[] }
    | { type: "impact_complete"; affectedTests: CiAffectedTest[] }
    | { type: "test_started"; testFile: string; index: number; total: number }
    | { type: "test_finished"; testFile: string; results: TestRunResult[] }
    | { type: "reports_written"; files: string[] };

export interface CiResult {
    impact: CiImpactReport;
    run: CiRunReport;
    /** Paths of the report files that were written. */
    reportFiles: string[];
    /** 0 = clean, 1 = test failures, 2 = infra error. */
    exitCode: 0 | 1 | 2;
}
