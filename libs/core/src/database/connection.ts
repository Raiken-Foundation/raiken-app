import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import type { DbAdapter } from "./adapter";
import { SqliteDbAdapter } from "./adapter";
import { DatabaseError } from "./errors";
import { SchemaManager } from "./schema/schema-manager";

export interface OpenDatabaseResult {
    adapter: DbAdapter;
    dbPath: string;
    projectPath: string;
    raw: Database.Database;
}

/**
 * Open a SQLite connection with Raiken pragmas, schema migration, and vec extension.
 */
export function openDatabase(projectPath: string, dbPath?: string): OpenDatabaseResult {
    const resolvedProjectPath = path.resolve(projectPath);
    const defaultDbPath = path.join(resolvedProjectPath, ".raiken", "raiken.db");
    const resolvedDbPath = dbPath || defaultDbPath;

    try {
        const dbDir = path.dirname(resolvedDbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const db = new Database(resolvedDbPath);

        try {
            loadSqliteVec(db);
        } catch (error) {
            throw new DatabaseError(
                "Failed to load sqlite-vec extension. Ensure dependencies are installed for your platform and reinstall after Node upgrades.",
                error as Error,
            );
        }

        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.pragma("synchronous = NORMAL");
        db.pragma("wal_autocheckpoint = 5000");
        db.pragma("busy_timeout = 5000");

        const adapter = new SqliteDbAdapter(db, resolvedProjectPath);
        new SchemaManager(adapter).ensureSchema();
        ensureGitignore(resolvedProjectPath);

        return {
            adapter,
            dbPath: resolvedDbPath,
            projectPath: resolvedProjectPath,
            raw: db,
        };
    } catch (error) {
        if (error instanceof DatabaseError) {
            throw error;
        }
        const msg = (error as Error).message || "";
        if (
            msg.includes("malformed") ||
            msg.includes("corrupt") ||
            msg.includes("not a database")
        ) {
            const backupPath = `${resolvedDbPath}.corrupt.${Date.now()}`;
            try {
                if (fs.existsSync(resolvedDbPath)) {
                    fs.renameSync(resolvedDbPath, backupPath);
                }
            } catch {
                /* best-effort backup */
            }
            throw new DatabaseError(
                `Database is corrupted. The broken file has been backed up to ${backupPath}. Restart Raiken to create a fresh database. Your code graph will be rebuilt automatically.`,
                error as Error,
            );
        }
        throw new DatabaseError(
            `Failed to initialize CodeGraphDB at ${resolvedDbPath}: ${msg}`,
            error as Error,
        );
    }
}

/**
 * Ensure .raiken/ is in .gitignore
 */
export function ensureGitignore(projectPath: string): void {
    const gitignorePath = path.join(projectPath, ".gitignore");
    const entry = ".raiken/";

    try {
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, "utf-8");
            if (!content.includes(entry)) {
                fs.appendFileSync(gitignorePath, `\n# Raiken analysis cache\n${entry}\n`);
            }
        }
    } catch {
        // Ignore gitignore errors - not critical
    }
}

export function closeDatabase(db: Database.Database): void {
    try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
    } catch (error) {
        console.warn("DB close warning:", (error as Error).message);
    }
}

export function vacuumDatabase(db: Database.Database): void {
    db.exec("VACUUM");
}
