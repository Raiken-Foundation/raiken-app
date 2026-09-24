import * as fs from "node:fs";
import * as path from "node:path";

export interface TraceRotationOptions {
    /** Maximum number of trace files to retain. Default 200. */
    maxFiles?: number;
    /** Maximum total bytes across all trace files. Default 50 MiB. */
    maxTotalBytes?: number;
    /** Delete files older than this age. Default 14 days. */
    maxAgeMs?: number;
}

export interface TraceRotationResult {
    deleted: string[];
    remainingFiles: number;
    remainingBytes: number;
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface TraceFileEntry {
    path: string;
    mtimeMs: number;
    size: number;
}

/** Resolve the canonical trace directory for a project. */
export function resolveProjectTraceDir(projectPath: string): string {
    return path.resolve(projectPath, ".raiken", "traces");
}

/** Ensure a trace directory stays under `<project>/.raiken/traces`. */
export function assertContainedTraceDir(dir: string, projectPath: string): string {
    const root = resolveProjectTraceDir(projectPath);
    const resolvedDir = path.resolve(dir);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolvedDir !== root && !resolvedDir.startsWith(rootWithSep)) {
        throw new Error("Trace directory must stay under .raiken/traces");
    }
    return resolvedDir;
}

function isPathInsideDir(filePath: string, dir: string): boolean {
    const resolvedFile = path.resolve(filePath);
    const resolvedDir = path.resolve(dir);
    const dirWithSep = resolvedDir.endsWith(path.sep) ? resolvedDir : `${resolvedDir}${path.sep}`;
    return resolvedFile === resolvedDir || resolvedFile.startsWith(dirWithSep);
}

function listTraceFiles(dir: string): TraceFileEntry[] {
    if (!fs.existsSync(dir)) return [];
    const entries: TraceFileEntry[] = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, name);
        if (!isPathInsideDir(filePath, dir)) continue;
        try {
            const stat = fs.lstatSync(filePath);
            if (!stat.isFile()) continue;
            entries.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
            // Skip unreadable entries rather than failing rotation.
        }
    }
    return entries;
}

/**
 * Bounded retention for `.raiken/traces/` — non-throwing by design.
 * Deletes oldest files first until within max file count, total bytes, and age limits.
 */
export function rotateTraceFiles(
    dir: string,
    options: TraceRotationOptions = {},
    projectPath?: string,
): TraceRotationResult {
    const safeDir = projectPath ? assertContainedTraceDir(dir, projectPath) : path.resolve(dir);
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_BYTES;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = Date.now();

    let files = listTraceFiles(safeDir);
    const deleted: string[] = [];

    const tryDelete = (filePath: string): void => {
        if (!isPathInsideDir(filePath, safeDir)) return;
        try {
            fs.unlinkSync(filePath);
            deleted.push(filePath);
        } catch {
            // Best effort — a locked file should not break rotation.
        }
    };

    for (const file of files) {
        if (now - file.mtimeMs > maxAgeMs) {
            tryDelete(file.path);
        }
    }
    files = listTraceFiles(safeDir);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    while (files.length > maxFiles || totalBytes > maxTotalBytes) {
        const oldest = files.shift();
        if (!oldest) break;
        tryDelete(oldest.path);
        totalBytes -= oldest.size;
    }

    const remaining = listTraceFiles(safeDir);
    return {
        deleted,
        remainingFiles: remaining.length,
        remainingBytes: remaining.reduce((sum, f) => sum + f.size, 0),
    };
}
