import * as crypto from "node:crypto";
import * as path from "node:path";

/** Stable short hash for correlating logs without exposing full paths. */
export function hashProjectPath(projectPath: string): string {
    const normalized = path.resolve(projectPath);
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Privacy-safe project reference for structured logs: basename + hash.
 * Absolute paths are never emitted.
 */
export function safeProjectRef(projectPath: string): string {
    const normalized = path.resolve(projectPath);
    const base = path.basename(normalized) || "project";
    return `${base}#${hashProjectPath(normalized)}`;
}
