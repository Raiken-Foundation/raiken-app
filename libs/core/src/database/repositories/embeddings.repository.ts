import type { DbAdapter } from "../adapter";

export class EmbeddingsRepository {
    constructor(private readonly adapter: DbAdapter) {}

    saveEmbeddings(
        fileId: number,
        chunks: Array<{
            type: "function" | "class" | "file" | "type";
            name: string;
            text: string;
            embedding: number[];
        }>,
    ): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                // Get embedding IDs BEFORE deleting from main table
                const oldEmbeddingIds = (
                    this.adapter.db
                        .prepare(`
        SELECT id FROM embeddings WHERE file_id = ?
      `)
                        .all(fileId) as Array<{ id: number }>
                ).map((row) => row.id);

                // Delete from vector table first
                for (const id of oldEmbeddingIds) {
                    this.adapter.db
                        .prepare(`
          DELETE FROM vec_embeddings WHERE rowid = ?
        `)
                        .run(id);
                }

                // Then delete from main embeddings table
                this.adapter.db
                    .prepare(`
        DELETE FROM embeddings WHERE file_id = ?
      `)
                    .run(fileId);

                const insertStmt = this.adapter.db.prepare(`
        INSERT INTO embeddings (file_id, chunk_type, chunk_name, chunk_text, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

                const insertVecStmt = this.adapter.db.prepare(`
        INSERT INTO vec_embeddings (rowid, embedding)
        VALUES (?, ?)
      `);

                for (const chunk of chunks) {
                    // Convert embedding array to Float32Array buffer
                    const embeddingBuffer = Buffer.from(new Float32Array(chunk.embedding).buffer);

                    // Insert into main table first
                    const result = insertStmt.run(
                        fileId,
                        chunk.type,
                        chunk.name,
                        chunk.text,
                        embeddingBuffer,
                        Date.now(),
                    );

                    // Insert into vector search table, keeping rowid aligned with
                    // embeddings.id for reliable joins. sqlite-vec's vec0 requires
                    // the primary key to be bound as a BigInt — a plain JS number
                    // is rejected ("Only integers are allowed for primary key
                    // values"), so coerce explicitly.
                    insertVecStmt.run(BigInt(result.lastInsertRowid), embeddingBuffer);
                }
            });

            transaction();
        });
    }

    /**
     * Search for similar code using vector similarity.
     *
     * @param queryEmbedding - The embedding vector to search for
     * @param limit - Maximum number of results (default: 10)
     * @param chunkTypes - Filter by chunk types (optional)
     * @returns Array of matching chunks with similarity scores
     */
    searchSimilar(
        queryEmbedding: number[],
        limit = 10,
        chunkTypes?: Array<"function" | "class" | "file" | "type">,
    ): Array<{
        fileId: number;
        filePath: string;
        chunkType: string;
        chunkName: string;
        chunkText: string;
        similarity: number;
    }> {
        const embeddingBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

        // Build query with optional type filter
        let query = `
    SELECT 
      e.file_id,
      f.relative_path,
      e.chunk_type,
      e.chunk_name,
      e.chunk_text,
      vec_distance_cosine(v.embedding, ?) as distance
    FROM embeddings e
    JOIN files f ON e.file_id = f.id
    JOIN vec_embeddings v ON v.rowid = e.id
    WHERE f.project_path = ?
  `;

        const params: (Buffer | string | number)[] = [embeddingBuffer, this.adapter.projectPath];

        if (chunkTypes && chunkTypes.length > 0) {
            const placeholders = chunkTypes.map(() => "?").join(",");
            query += ` AND e.chunk_type IN (${placeholders})`;
            params.push(...chunkTypes);
        }

        query += ` ORDER BY distance ASC LIMIT ?`;
        params.push(limit);

        const results = this.adapter.db.prepare(query).all(...params) as Array<{
            file_id: number;
            relative_path: string;
            chunk_type: string;
            chunk_name: string;
            chunk_text: string;
            distance: number;
        }>;

        return results.map((row) => ({
            fileId: row.file_id,
            filePath: row.relative_path,
            chunkType: row.chunk_type,
            chunkName: row.chunk_name,
            chunkText: row.chunk_text,
            similarity: 1 - row.distance, // Convert distance to similarity (0-1)
        }));
    }

    /**
     * Get all embeddings for a specific file.
     *
     * @param fileId - The database ID of the file
     * @returns Array of embeddings with metadata
     */
    getFileEmbeddings(fileId: number): Array<{
        id: number;
        chunkType: string;
        chunkName: string;
        chunkText: string;
        createdAt: number;
    }> {
        const results = this.adapter.db
            .prepare(`
    SELECT id, chunk_type, chunk_name, chunk_text, created_at
    FROM embeddings
    WHERE file_id = ?
    ORDER BY chunk_type, chunk_name
  `)
            .all(fileId) as Array<{
            id: number;
            chunk_type: string;
            chunk_name: string;
            chunk_text: string;
            created_at: number;
        }>;

        return results.map((row) => ({
            id: row.id,
            chunkType: row.chunk_type,
            chunkName: row.chunk_name,
            chunkText: row.chunk_text,
            createdAt: row.created_at,
        }));
    }

    /**
     * Delete all embeddings for a specific file.
     *
     * @param fileId - The database ID of the file
     */
    deleteFileEmbeddings(fileId: number): void {
        this.adapter.runWithRetry(() => {
            const transaction = this.adapter.db.transaction(() => {
                // Get embedding IDs first
                const embeddingIds = (
                    this.adapter.db
                        .prepare(`
        SELECT id FROM embeddings WHERE file_id = ?
      `)
                        .all(fileId) as Array<{ id: number }>
                ).map((row) => row.id);

                // Delete from vector table
                for (const id of embeddingIds) {
                    this.adapter.db
                        .prepare(`
          DELETE FROM vec_embeddings WHERE rowid = ?
        `)
                        .run(id);
                }

                // Delete from main table
                this.adapter.db
                    .prepare(`
        DELETE FROM embeddings WHERE file_id = ?
      `)
                    .run(fileId);
            });

            transaction();
        });
    }

    /**
     * Get count of embeddings in the database.
     */
    getEmbeddingsCount(): number {
        const result = this.adapter.db
            .prepare(`
    SELECT COUNT(*) as count FROM embeddings
  `)
            .get() as { count: number };
        return result.count;
    }

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
     * Check if a file has embeddings.
     *
     * @param fileId - The database ID of the file
     * @returns True if embeddings exist
     */
    hasEmbeddings(fileId: number): boolean {
        const result = this.adapter.db
            .prepare(`
    SELECT 1 FROM embeddings WHERE file_id = ? LIMIT 1
  `)
            .get(fileId);
        return result !== undefined;
    }

    // ==========================================================================
    // Keyword Index Operations
    // ==========================================================================

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
