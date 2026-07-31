import type { DbAdapter } from "../adapter";

export class MemoryRepository {
    constructor(private readonly adapter: DbAdapter) {}

    setPreference(key: string, value: string): void {
        this.adapter.runWithRetry(() => {
            this.adapter.db
                .prepare(`
      INSERT OR REPLACE INTO preferences (project_path, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `)
                .run(this.adapter.projectPath, key, value, Date.now());
        });
    }

    /**
     * Get a preference value.
     */
    getPreference(key: string): string | null {
        const result = this.adapter.db
            .prepare(`
    SELECT value FROM preferences WHERE project_path = ? AND key = ?
  `)
            .get(this.adapter.projectPath, key) as { value: string } | undefined;
        return result?.value ?? null;
    }

    /**
     * Get all preferences for this project.
     */
    getAllPreferences(): Record<string, string> {
        const rows = this.adapter.db
            .prepare(`
    SELECT key, value FROM preferences WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as Array<{ key: string; value: string }>;

        const prefs: Record<string, string> = {};
        for (const row of rows) {
            prefs[row.key] = row.value;
        }
        return prefs;
    }

    // ==========================================================================
    // Selector History Operations
    // ==========================================================================

    /**
     * Record a successful selector usage.
     */
    recordSelectorSuccess(
        elementDescription: string,
        selector: string,
        selectorType: string,
    ): void {
        this.adapter.runWithRetry(() => {
            const now = Date.now();
            const existing = this.adapter.db
                .prepare(`
      SELECT id, success_count FROM selector_history 
      WHERE project_path = ? AND element_description = ? AND selector = ?
    `)
                .get(this.adapter.projectPath, elementDescription, selector) as
                | { id: number; success_count: number }
                | undefined;

            if (existing) {
                // Increment in SQL (not read value + 1) so concurrent updates
                // from multiple connections don't clobber each other's count.
                this.adapter.db
                    .prepare(`
        UPDATE selector_history 
        SET success_count = success_count + 1, last_used = ?
        WHERE id = ?
      `)
                    .run(now, existing.id);
            } else {
                this.adapter.db
                    .prepare(`
        INSERT INTO selector_history (project_path, element_description, selector, selector_type, success_count, last_used, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `)
                    .run(
                        this.adapter.projectPath,
                        elementDescription,
                        selector,
                        selectorType,
                        now,
                        now,
                    );
            }
        });
    }

    /**
     * Record a failed selector usage.
     * Inserts a row on first-ever failure so "this selector never works" is
     * observable rather than silently dropped.
     */
    recordSelectorFailure(
        elementDescription: string,
        selector: string,
        selectorType: string = "other",
    ): void {
        this.adapter.runWithRetry(() => {
            const now = Date.now();
            const existing = this.adapter.db
                .prepare(`
      SELECT id, failure_count FROM selector_history 
      WHERE project_path = ? AND element_description = ? AND selector = ?
    `)
                .get(this.adapter.projectPath, elementDescription, selector) as
                | { id: number; failure_count: number }
                | undefined;

            if (existing) {
                // Increment in SQL to avoid lost updates under concurrency.
                this.adapter.db
                    .prepare(`
        UPDATE selector_history 
        SET failure_count = failure_count + 1, last_used = ?
        WHERE id = ?
      `)
                    .run(now, existing.id);
            } else {
                this.adapter.db
                    .prepare(`
        INSERT INTO selector_history (project_path, element_description, selector, selector_type, success_count, failure_count, last_used, created_at)
        VALUES (?, ?, ?, ?, 0, 1, ?, ?)
      `)
                    .run(
                        this.adapter.projectPath,
                        elementDescription,
                        selector,
                        selectorType,
                        now,
                        now,
                    );
            }
        });
    }

    /**
     * Get the best selector for an element based on success/failure ratio.
     */
    getBestSelector(
        elementDescription: string,
    ): { selector: string; selectorType: string; confidence: number } | null {
        const result = this.adapter.db
            .prepare(`
    SELECT selector, selector_type, success_count, failure_count
    FROM selector_history
    WHERE project_path = ? AND element_description = ?
    ORDER BY (success_count - failure_count) DESC, last_used DESC
    LIMIT 1
  `)
            .get(this.adapter.projectPath, elementDescription) as
            | {
                  selector: string;
                  selector_type: string;
                  success_count: number;
                  failure_count: number;
              }
            | undefined;

        if (!result) return null;

        const total = result.success_count + result.failure_count;
        const confidence = total > 0 ? result.success_count / total : 0;

        return {
            selector: result.selector,
            selectorType: result.selector_type,
            confidence,
        };
    }

    /**
     * Get all successful selectors (for prompt context).
     */
    getSuccessfulSelectors(
        limit = 20,
    ): Array<{ element: string; selector: string; type: string; confidence: number }> {
        const rows = this.adapter.db
            .prepare(`
    SELECT element_description, selector, selector_type, success_count, failure_count
    FROM selector_history
    WHERE project_path = ? AND success_count > failure_count
    ORDER BY (success_count - failure_count) DESC, last_used DESC
    LIMIT ?
  `)
            .all(this.adapter.projectPath, limit) as Array<{
            element_description: string;
            selector: string;
            selector_type: string;
            success_count: number;
            failure_count: number;
        }>;

        return rows.map((row) => ({
            element: row.element_description,
            selector: row.selector,
            type: row.selector_type,
            confidence: row.success_count / (row.success_count + row.failure_count),
        }));
    }

    /**
     * Aggregate selector_history by type to find the strategy with the most
     * recorded successes project-wide. Returns null when there isn't enough
     * signal yet (no rows, or the leading type never actually won more than
     * it lost).
     */
    getDominantSelectorType(): { type: string; successCount: number } | null {
        const rows = this.adapter.db
            .prepare(`
    SELECT selector_type, SUM(success_count) as total_success, SUM(failure_count) as total_failure
    FROM selector_history
    WHERE project_path = ?
    GROUP BY selector_type
    ORDER BY total_success DESC
    LIMIT 1
  `)
            .all(this.adapter.projectPath) as Array<{
            selector_type: string;
            total_success: number;
            total_failure: number;
        }>;

        const top = rows[0];
        if (!top || top.total_success <= top.total_failure) return null;
        return { type: top.selector_type, successCount: top.total_success };
    }

    pruneSelectorHistory(maxSelectors = 500): void {
        this.adapter.runWithRetry(() => {
            this.adapter.db
                .prepare(`
        DELETE FROM selector_history WHERE project_path = ? AND id NOT IN (
          SELECT id FROM selector_history WHERE project_path = ? ORDER BY last_used DESC LIMIT ?
        )
      `)
                .run(this.adapter.projectPath, this.adapter.projectPath, maxSelectors);
        });
    }
}
