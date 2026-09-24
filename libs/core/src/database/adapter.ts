import type Database from "better-sqlite3";
import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from "./constants";
import { DatabaseError } from "./errors";

export interface DbAdapter {
    readonly db: Database.Database;
    readonly projectPath: string;
    runWithRetry<T>(fn: () => T, retries?: number): T;
}

export class SqliteDbAdapter implements DbAdapter {
    constructor(
        readonly db: Database.Database,
        readonly projectPath: string,
    ) {}

    runWithRetry<T>(fn: () => T, retries = RETRY_ATTEMPTS): T {
        try {
            return fn();
        } catch (error: unknown) {
            const sqliteError = error as { code?: string };
            if (sqliteError.code === "SQLITE_BUSY" && retries > 0) {
                const start = Date.now();
                while (Date.now() - start < RETRY_DELAY_MS) {
                    // spin-wait; better-sqlite3 is synchronous so we can't await
                }
                return this.runWithRetry(fn, retries - 1);
            }
            throw new DatabaseError(
                `Database operation failed: ${(error as Error).message}`,
                error as Error,
            );
        }
    }
}
