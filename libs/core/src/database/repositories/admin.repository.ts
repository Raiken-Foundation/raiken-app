import type { DbAdapter } from "../adapter";

export class AdminRepository {
    constructor(private readonly adapter: DbAdapter) {}

    getTables(): Array<{ name: string; row_count: number }> {
        const tables = this.adapter.db
            .prepare(`
    SELECT name 
    FROM sqlite_master 
    WHERE type='table' 
    AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)
            .all() as Array<{ name: string }>;

        return tables.map((table) => ({
            name: table.name,
            row_count: this.getTableCount(table.name),
        }));
    }

    /**
     * Get row count for a specific table.
     */
    getTableCount(tableName: string): number {
        if (!this.isValidTableName(tableName)) {
            return 0;
        }
        try {
            const result = this.adapter.db
                .prepare(`SELECT COUNT(*) as count FROM "${tableName}"`)
                .get() as { count: number };
            return result.count;
        } catch {
            return 0;
        }
    }

    /**
     * Query a table with pagination.
     */
    queryTable(tableName: string, limit: number, offset: number): unknown[] {
        if (!this.isValidTableName(tableName)) {
            return [];
        }
        try {
            return this.adapter.db
                .prepare(`
      SELECT * FROM "${tableName}"
      LIMIT ? OFFSET ?
    `)
                .all(limit, offset);
        } catch (error) {
            console.error(`Error querying table ${tableName}:`, error);
            return [];
        }
    }

    private isValidTableName(name: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    }

    /**
     * Execute a custom SQL query (SELECT only for safety).
     */
    executeQuery(query: string, params: unknown[] = []): unknown[] {
        // Only allow SELECT queries for safety
        const trimmedQuery = query.trim().toUpperCase();
        if (!trimmedQuery.startsWith("SELECT")) {
            throw new Error("Only SELECT queries are allowed");
        }

        try {
            return this.adapter.db.prepare(query).all(...params);
        } catch (error) {
            throw new Error(`Query execution failed: ${(error as Error).message}`);
        }
    }
}
