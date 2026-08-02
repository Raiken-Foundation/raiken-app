import type { DbAdapter } from "../adapter";
import { normalizeTestFileKey } from "../utils/test-file-key";

export class TestOutcomesRepository {
    constructor(private readonly adapter: DbAdapter) {}

    recordTestGenerated(
        testFile: string,
        testName: string,
        sourcePrompt: string,
        generatedCode: string,
    ): number {
        const result = this.adapter.runWithRetry(() => {
            return this.adapter.db
                .prepare(`
      INSERT INTO test_outcomes (project_path, test_file, test_name, source_prompt, generated_code, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `)
                .run(
                    this.adapter.projectPath,
                    normalizeTestFileKey(testFile),
                    testName,
                    sourcePrompt,
                    generatedCode,
                    Date.now(),
                );
        });
        return Number(result.lastInsertRowid);
    }

    /**
     * Record the result of running a test.
     */
    recordTestResult(
        testId: number,
        status: "passed" | "failed" | "error" | "timeout",
        executionTimeMs?: number,
        errorMessage?: string,
        failingSelector?: string,
    ): void {
        this.adapter.runWithRetry(() => {
            this.adapter.db
                .prepare(`
      UPDATE test_outcomes 
      SET status = ?, execution_time_ms = ?, error_message = ?, failing_selector = ?, last_run = ?, retry_count = retry_count + 1
      WHERE id = ?
    `)
                .run(
                    status,
                    executionTimeMs ?? null,
                    errorMessage ?? null,
                    failingSelector ?? null,
                    Date.now(),
                    testId,
                );
        });
    }

    /**
     * Record the outcome of running an arbitrary spec — one the agent did not
     * generate, so there is no prior `recordTestGenerated` row to attach to.
     * Updates the newest row for (test_file, test_name) when one exists
     * (keeping an agent-generated test's history in one place), otherwise
     * inserts a runner-origin row with empty agent-only columns. This is what
     * lets `raiken test` / `report` / `ci` feed the same failure memory that
     * `raiken context` and repair prompts read.
     */
    upsertRunOutcome(input: {
        testFile: string;
        testName: string;
        status: "passed" | "failed" | "error" | "timeout";
        executionTimeMs?: number;
        errorMessage?: string;
        failingSelector?: string;
    }): void {
        const testFile = normalizeTestFileKey(input.testFile);
        const now = Date.now();
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const existing = this.adapter.db
                    .prepare(`
      SELECT id FROM test_outcomes
      WHERE project_path = ? AND test_file = ? AND test_name = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
                    .get(this.adapter.projectPath, testFile, input.testName) as
                    | { id: number }
                    | undefined;

                if (existing) {
                    this.adapter.db
                        .prepare(`
      UPDATE test_outcomes
      SET status = ?, execution_time_ms = ?, error_message = ?, failing_selector = ?, last_run = ?, retry_count = retry_count + 1
      WHERE id = ?
    `)
                        .run(
                            input.status,
                            input.executionTimeMs ?? null,
                            input.errorMessage ?? null,
                            input.failingSelector ?? null,
                            now,
                            existing.id,
                        );
                    return;
                }

                this.adapter.db
                    .prepare(`
      INSERT INTO test_outcomes (project_path, test_file, test_name, source_prompt, generated_code, status, error_message, failing_selector, execution_time_ms, created_at, last_run, origin)
      VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, 'runner')
    `)
                    .run(
                        this.adapter.projectPath,
                        testFile,
                        input.testName,
                        input.status,
                        input.errorMessage ?? null,
                        input.failingSelector ?? null,
                        input.executionTimeMs ?? null,
                        now,
                        now,
                    );
            });
            transaction();
        });
    }

    /**
     * Get recent test failures.
     */
    getRecentFailures(limit = 10): Array<{
        id: number;
        testFile: string;
        testName: string;
        errorMessage: string | null;
        failingSelector: string | null;
        lastRun: number;
    }> {
        const rows = this.adapter.db
            .prepare(`
    SELECT id, test_file, test_name, error_message, failing_selector, last_run
    FROM test_outcomes
    WHERE project_path = ? AND status IN ('failed', 'error')
    ORDER BY last_run DESC
    LIMIT ?
  `)
            .all(this.adapter.projectPath, limit) as Array<{
            id: number;
            test_file: string;
            test_name: string;
            error_message: string | null;
            failing_selector: string | null;
            last_run: number;
        }>;

        return rows.map((row) => ({
            id: row.id,
            testFile: row.test_file,
            testName: row.test_name,
            errorMessage: row.error_message,
            failingSelector: row.failing_selector,
            lastRun: row.last_run,
        }));
    }

    /**
     * Get a test outcome by ID.
     */
    getTestOutcome(testId: number): {
        id: number;
        testFile: string;
        testName: string;
        sourcePrompt: string;
        generatedCode: string;
        status: string;
        errorMessage: string | null;
    } | null {
        const result = this.adapter.db
            .prepare(`
    SELECT id, test_file, test_name, source_prompt, generated_code, status, error_message
    FROM test_outcomes
    WHERE id = ?
  `)
            .get(testId) as
            | {
                  id: number;
                  test_file: string;
                  test_name: string;
                  source_prompt: string;
                  generated_code: string;
                  status: string;
                  error_message: string | null;
              }
            | undefined;

        if (!result) return null;

        return {
            id: result.id,
            testFile: result.test_file,
            testName: result.test_name,
            sourcePrompt: result.source_prompt,
            generatedCode: result.generated_code,
            status: result.status,
            errorMessage: result.error_message,
        };
    }

    /**
     * Get the ID of the most recently generated outcome row for a test file.
     * Used to attach a later `recordTestResult` call to the generation that
     * produced the file currently on disk, without threading a testId through
     * every save→run call site.
     */
    getLatestTestOutcomeId(testFile: string): number | null {
        // Order by id (not created_at) as the tiebreaker: two generations of
        // the same file within the same millisecond must still resolve to the
        // one inserted last, and autoincrement id is monotonic where a
        // millisecond timestamp isn't.
        const row = this.adapter.db
            .prepare(`
    SELECT id FROM test_outcomes
    WHERE project_path = ? AND test_file = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
            .get(this.adapter.projectPath, normalizeTestFileKey(testFile)) as
            | { id: number }
            | undefined;
        return row ? row.id : null;
    }

    /**
     * Get the most recent outcome (status + timestamps) for every test file
     * that has at least one recorded generation/run, keyed by test file path.
     * Used to derive fresh/stale/broken status in the files panel without a
     * per-file round trip.
     */
    getLatestOutcomesPerFile(): Map<
        string,
        { status: string; lastRun: number | null; createdAt: number }
    > {
        const rows = this.adapter.db
            .prepare(`
    SELECT test_file, status, last_run, created_at
    FROM test_outcomes
    WHERE project_path = ?
    ORDER BY test_file, created_at DESC, id DESC
  `)
            .all(this.adapter.projectPath) as Array<{
            test_file: string;
            status: string;
            last_run: number | null;
            created_at: number;
        }>;

        const result = new Map<
            string,
            { status: string; lastRun: number | null; createdAt: number }
        >();
        for (const row of rows) {
            // Normalize on the way out too: rows written before key
            // normalization existed may carry native separators.
            const key = normalizeTestFileKey(row.test_file);
            // First row per test_file wins (ORDER BY puts the newest first).
            if (result.has(key)) continue;
            result.set(key, {
                status: row.status,
                lastRun: row.last_run,
                createdAt: row.created_at,
            });
        }
        return result;
    }

    /**
     * Get the source files a generated test is mapped to (reverse of
     * `getAffectedTests`), used to detect staleness when a source file
     * changed more recently than the test's last recorded run.
     */
    getSourceFilesForTest(testFile: string): string[] {
        const rows = this.adapter.db
            .prepare(`
    SELECT source_file FROM test_source_map
    WHERE project_path = ? AND test_file = ?
  `)
            .all(this.adapter.projectPath, normalizeTestFileKey(testFile)) as Array<{
            source_file: string;
        }>;
        return rows.map((r) => r.source_file);
    }

    /**
     * Record which source files a generated test covers.
     */
    recordTestSourceFiles(testFile: string, sourceFiles: string[]): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const now = Date.now();
                const stmt = this.adapter.db.prepare(`
        INSERT OR IGNORE INTO test_source_map (project_path, test_file, source_file, created_at)
        VALUES (?, ?, ?, ?)
      `);
                for (const src of sourceFiles) {
                    stmt.run(this.adapter.projectPath, normalizeTestFileKey(testFile), src, now);
                }
            });
            transaction();
        });
    }

    /**
     * Repoint persisted records at a test file's new path after a move/rename
     * (used by `raiken organize`). Keeps `test_source_map` and `test_outcomes`
     * — and therefore stale/fresh status and impact analysis — accurate
     * without losing the file's generation/run history across the move.
     */
    renameTestRecords(rawOldTestFile: string, rawNewTestFile: string): void {
        const oldTestFile = normalizeTestFileKey(rawOldTestFile);
        const newTestFile = normalizeTestFileKey(rawNewTestFile);
        if (oldTestFile === newTestFile) return;
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                this.adapter.db
                    .prepare(
                        "UPDATE test_outcomes SET test_file = ? WHERE project_path = ? AND test_file = ?",
                    )
                    .run(newTestFile, this.adapter.projectPath, oldTestFile);
                // test_source_map has a UNIQUE(project_path, test_file, source_file)
                // constraint; if the destination already has an (identical) mapping
                // row, the plain UPDATE would violate it. INSERT OR IGNORE the
                // renamed rows first, then drop the stale originals.
                const rows = this.adapter.db
                    .prepare(
                        "SELECT source_file, created_at FROM test_source_map WHERE project_path = ? AND test_file = ?",
                    )
                    .all(this.adapter.projectPath, oldTestFile) as Array<{
                    source_file: string;
                    created_at: number;
                }>;
                const insert = this.adapter.db.prepare(`
        INSERT OR IGNORE INTO test_source_map (project_path, test_file, source_file, created_at)
        VALUES (?, ?, ?, ?)
      `);
                for (const row of rows) {
                    insert.run(
                        this.adapter.projectPath,
                        newTestFile,
                        row.source_file,
                        row.created_at,
                    );
                }
                this.adapter.db
                    .prepare("DELETE FROM test_source_map WHERE project_path = ? AND test_file = ?")
                    .run(this.adapter.projectPath, oldTestFile);
            });
            transaction();
        });
    }

    /**
     * Remove all persisted records for a deleted test file so impact analysis
     * (getAffectedTests) and the failures-in-prompts memory don't keep pointing
     * at a test that no longer exists on disk. `testFile` is the project-relative
     * path used when the mapping was recorded.
     */
    deleteTestRecords(testFile: string): void {
        const key = normalizeTestFileKey(testFile);
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                this.adapter.db
                    .prepare("DELETE FROM test_source_map WHERE project_path = ? AND test_file = ?")
                    .run(this.adapter.projectPath, key);
                this.adapter.db
                    .prepare("DELETE FROM test_outcomes WHERE project_path = ? AND test_file = ?")
                    .run(this.adapter.projectPath, key);
            });
            transaction();
        });
    }

    /**
     * Given a list of changed source files, return the test files that cover them.
     * Uses both the explicit test_source_map and the dependency graph (dependents).
     */
    getAffectedTests(changedSourceFiles: string[]): Array<{
        testFile: string;
        reason: "source_map" | "dependency";
        sourceFile: string;
    }> {
        if (changedSourceFiles.length === 0) return [];

        const results: Array<{
            testFile: string;
            reason: "source_map" | "dependency";
            sourceFile: string;
        }> = [];
        const seen = new Set<string>();

        for (const srcFile of changedSourceFiles) {
            const mapped = this.adapter.db
                .prepare(`
      SELECT test_file FROM test_source_map
      WHERE project_path = ? AND source_file = ?
    `)
                .all(this.adapter.projectPath, srcFile) as Array<{ test_file: string }>;

            for (const row of mapped) {
                const key = `${row.test_file}::${srcFile}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push({
                        testFile: row.test_file,
                        reason: "source_map",
                        sourceFile: srcFile,
                    });
                }
            }

            const dependents = this.adapter.db
                .prepare(`
      SELECT source_file FROM dependencies
      WHERE project_path = ? AND target_file = ?
    `)
                .all(this.adapter.projectPath, srcFile) as Array<{ source_file: string }>;

            for (const dep of dependents) {
                if (this.isTestFilePath(dep.source_file)) {
                    const key = `${dep.source_file}::${srcFile}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        results.push({
                            testFile: dep.source_file,
                            reason: "dependency",
                            sourceFile: srcFile,
                        });
                    }
                }
            }
        }

        return results;
    }

    private isTestFilePath(filePath: string): boolean {
        const lower = filePath.toLowerCase();
        return (
            /\.(spec|test|e2e)\.[jt]sx?$/.test(lower) ||
            lower.includes("/tests/") ||
            lower.includes("/test/") ||
            lower.includes("/__tests__/") ||
            lower.includes("/e2e/")
        );
    }

    pruneTestOutcomes(maxOutcomes = 200): void {
        this.adapter.runWithRetry(() => {
            this.adapter.db
                .prepare(`
        DELETE FROM test_outcomes WHERE project_path = ? AND id NOT IN (
          SELECT id FROM test_outcomes WHERE project_path = ? ORDER BY created_at DESC LIMIT ?
        )
      `)
                .run(this.adapter.projectPath, this.adapter.projectPath, maxOutcomes);
        });
    }
}
