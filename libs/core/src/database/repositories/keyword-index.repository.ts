import type { DbAdapter } from "../adapter";

/**
 * Keyword-index persistence for code-graph search (the replacement for the
 * removed embeddings/vector store — see the sqlite-vec/xenova cut). Owns the
 * `keyword_index` table plus the small `files`-table ID lookup it grew from.
 */
export class KeywordIndexRepository {
    constructor(private readonly adapter: DbAdapter) {}

    /**
     * Get the DB file record ID for a given file path.
     * Returns null if the file is not in the database.
     */
    getFileId(filePath: string): number | null {
        const result = this.adapter.db
            .prepare(`
    SELECT id FROM files WHERE project_path = ? AND file_path = ?
  `)
            .get(this.adapter.projectPath, filePath) as { id: number } | undefined;
        return result?.id ?? null;
    }

    /**
     * Save keyword index to database.
     *
     * @param index - Map of keyword -> file paths
     */
    saveKeywordIndex(index: Map<string, string[]>): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                const now = Date.now();

                // Clear existing index for this project
                this.adapter.db
                    .prepare(`
        DELETE FROM keyword_index WHERE project_path = ?
      `)
                    .run(this.adapter.projectPath);

                // Insert new index
                const insertStmt = this.adapter.db.prepare(`
        INSERT INTO keyword_index (keyword, file_path, project_path, updated_at)
        VALUES (?, ?, ?, ?)
      `);

                for (const [keyword, files] of index) {
                    for (const filePath of files) {
                        insertStmt.run(keyword, filePath, this.adapter.projectPath, now);
                    }
                }
            });

            transaction();
        });
    }

    /**
     * Load keyword index from database.
     *
     * @returns Map of keyword -> file paths, or null if not found
     */
    loadKeywordIndex(): Map<string, string[]> | null {
        const rows = this.adapter.db
            .prepare(`
    SELECT keyword, file_path FROM keyword_index WHERE project_path = ?
  `)
            .all(this.adapter.projectPath) as Array<{ keyword: string; file_path: string }>;

        if (rows.length === 0) {
            return null;
        }

        const index = new Map<string, string[]>();
        for (const row of rows) {
            const existing = index.get(row.keyword) || [];
            existing.push(row.file_path);
            index.set(row.keyword, existing);
        }

        return index;
    }
}
