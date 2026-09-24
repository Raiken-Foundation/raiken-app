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

    private isValidTableName(name: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    }
}
