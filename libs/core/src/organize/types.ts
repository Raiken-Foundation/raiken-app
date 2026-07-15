/**
 * Shared types for `raiken organize` — an AI-assisted pass that proposes (and,
 * on confirmation, applies) a feature/suite-based reorganization of the test
 * directory plus a deterministic cleanup of `raiken.config.json`.
 */

export interface TestInventoryEntry {
    /** Path relative to the project root, e.g. "e2e/login.spec.ts". */
    relativePath: string;
    /** `test.describe(...)` / top-level `test(...)` titles found in the file. */
    titles: string[];
    /** Source files this test is known to cover (from `test_source_map`), if any. */
    sourceFiles: string[];
    /** Bytes on disk — lets the AI deprioritize reorganizing trivial/empty files. */
    sizeBytes: number;
}

export interface OrganizeMove {
    /** Current path, relative to the project root. */
    from: string;
    /** Proposed new path, relative to the project root. */
    to: string;
    /** One-sentence rationale, shown in the dry-run report. */
    reason: string;
}

export interface OrganizeWarning {
    /** File the warning is about, if applicable (relative path). */
    file?: string;
    message: string;
}

export interface TestOrganizePlan {
    /** Short description of the taxonomy the AI chose (folders/suites). */
    summary: string;
    moves: OrganizeMove[];
    warnings: OrganizeWarning[];
    /** Model used to produce the plan; absent when no AI key was available. */
    usedModel?: string;
}

export interface ConfigCleanupChange {
    /** Dot-path within raiken.config.json, e.g. "discovery.excludePatterns". */
    path: string;
    description: string;
    before: unknown;
    after: unknown;
}

export interface ConfigCleanupResult {
    changes: ConfigCleanupChange[];
    /** The full config object with all changes applied, ready to write back. */
    cleanedConfig: Record<string, unknown>;
    /** True when no raiken.config.json exists (nothing to clean). */
    skipped: boolean;
}

export interface OrganizeOptions {
    projectPath: string;
    /** Defaults to raiken.config.json's testDirectory, then "e2e". */
    testDirectory?: string;
    includeTests?: boolean;
    includeConfig?: boolean;
    ai?: {
        apiKey?: string;
        model?: string;
        baseURL?: string;
        provider?: string;
    };
    /** Skip the LLM call entirely (e.g. no API key); test plan comes back empty. */
    skipAI?: boolean;
}

export interface OrganizeResult {
    testDirectory: string;
    testPlan?: TestOrganizePlan;
    configCleanup?: ConfigCleanupResult;
}

export interface OrganizeApplyResult {
    movedFiles: number;
    /** Files whose relative import specifiers were rewritten to follow the moves. */
    rewrittenImportFiles: number;
    configWritten: boolean;
    errors: string[];
}
