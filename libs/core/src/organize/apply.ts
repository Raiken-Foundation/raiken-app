/**
 * Applies a previously-generated `OrganizeResult` (file moves + config
 * cleanup) to disk. Never called implicitly by `runOrganize` — callers
 * always show the plan first and only reach this after explicit
 * confirmation (or `--yes`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readRawConfigSync, writeConfigAtomicSync } from "../config";
import { CodeGraphDB } from "../database/db";
import { analyzeConfigCleanup } from "./config-cleanup";
import { rewriteFileImports } from "./imports";
import { listTestDirectoryFiles } from "./inventory";
import { toNativePath, toPosixPath } from "./path-utils";
import type { OrganizeApplyResult, OrganizeMove, OrganizeResult } from "./types";

export async function applyOrganizePlan(
    projectPath: string,
    result: OrganizeResult,
): Promise<OrganizeApplyResult> {
    const errors: string[] = [];
    let movedFiles = 0;
    let rewrittenImportFiles = 0;

    const moves = result.testPlan?.moves ?? [];
    if (moves.length > 0) {
        const applied = applyMoves(projectPath, moves, errors);
        movedFiles = applied.length;
        if (applied.length > 0) {
            rewrittenImportFiles = rewriteRelativeImports(
                projectPath,
                result.testDirectory,
                applied,
                errors,
            );
            // Path-form quarantine entries must follow moved specs — a flaky
            // test that moves silently escapes quarantine otherwise (review
            // finding). Runs BEFORE the config-cleanup write below, which
            // re-reads the current config and therefore preserves this.
            if (rewriteQuarantineEntries(projectPath, applied, errors)) {
                // count via configWritten below if no other config write happens
            }
        }
    }

    let configWritten = false;
    if (
        result.configCleanup &&
        !result.configCleanup.skipped &&
        result.configCleanup.changes.length > 0
    ) {
        try {
            // Re-run the deterministic cleanup passes on the CURRENT config
            // instead of writing the plan-time snapshot — edits made between
            // proposal and confirmation (key rotation, a new quarantine
            // entry) must not be silently reverted (review finding).
            const fresh = await analyzeConfigCleanup(projectPath);
            if (!fresh.skipped) {
                writeConfigAtomicSync(projectPath, fresh.cleanedConfig);
                configWritten = true;
            } else {
                errors.push(
                    "raiken.config.json changed since the plan was proposed — config cleanup skipped; re-run organize to pick up the new state.",
                );
            }
        } catch (err) {
            errors.push(
                `Failed to write raiken.config.json: ${err instanceof Error ? err.message : err}`,
            );
        }
    }

    return { movedFiles, rewrittenImportFiles, configWritten, errors };
}

/**
 * Rewrite path-form `quarantine.testFiles` entries for specs that just moved
 * (from → to). Returns true when the config was rewritten.
 */
function rewriteQuarantineEntries(
    projectPath: string,
    applied: OrganizeMove[],
    errors: string[],
): boolean {
    try {
        const raw = readRawConfigSync(projectPath);
        const quarantine = raw["quarantine"] as { testFiles?: unknown } | undefined;
        const files = quarantine?.testFiles;
        if (!Array.isArray(files) || files.length === 0) return false;
        const fromByPosix = new Map<string, string>(
            applied.map((move) => [toPosixPath(move.from), toPosixPath(move.to)] as const),
        );
        let changed = false;
        const next = files.map((entry) => {
            if (typeof entry !== "string") return entry;
            const normalized = toPosixPath(entry).replace(/^\.\//, "");
            const to = fromByPosix.get(normalized);
            if (to === undefined) return entry;
            changed = true;
            return to;
        });
        if (!changed) return false;
        raw["quarantine"] = { ...quarantine, testFiles: next };
        writeConfigAtomicSync(projectPath, raw);
        return true;
    } catch (err) {
        // A missing config simply means nothing to rewrite.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        errors.push(
            `Moved test files but failed to update quarantine entries in raiken.config.json: ${
                err instanceof Error ? err.message : err
            } — update them manually or the moved specs will escape quarantine.`,
        );
        return false;
    }
}

/**
 * Two-phase rename (source -> staging -> destination) so that move chains —
 * e.g. A's destination is B's current path, and B moves elsewhere — never
 * collide mid-apply regardless of the order the plan lists them in.
 *
 * Returns the moves that actually landed at their destination.
 */
function applyMoves(projectPath: string, moves: OrganizeMove[], errors: string[]): OrganizeMove[] {
    const staged: Array<{ stagingPath: string; to: string; from: string }> = [];
    let db: CodeGraphDB | null = null;
    const applied: OrganizeMove[] = [];

    try {
        for (const move of moves) {
            const absFrom = path.resolve(projectPath, move.from);
            const stagingPath = `${absFrom}.raiken-organize-${process.pid}-${staged.length}.tmp`;
            try {
                fs.renameSync(absFrom, stagingPath);
                staged.push({ stagingPath, to: move.to, from: move.from });
            } catch (err) {
                errors.push(
                    `Failed to move "${move.from}": ${err instanceof Error ? err.message : err}`,
                );
            }
        }

        try {
            db = new CodeGraphDB(projectPath);
        } catch {
            db = null; // Non-fatal — the file move still succeeds without DB bookkeeping.
        }

        for (const item of staged) {
            const absTo = path.resolve(projectPath, item.to);

            // `renameSync` clobbers an existing destination (POSIX semantics).
            // Plan-time collision checks can't help here: a sibling move may have
            // failed to stage (leaving its file in place), or the destination may
            // have appeared between plan and confirmation. Never overwrite —
            // roll the staged file back instead.
            if (fs.existsSync(absTo)) {
                errors.push(
                    `Skipped "${item.from}" -> "${item.to}": destination already exists; not overwriting.`,
                );
                restoreStagedFile(projectPath, item, errors);
                continue;
            }

            try {
                fs.mkdirSync(path.dirname(absTo), { recursive: true });
                fs.renameSync(item.stagingPath, absTo);
                applied.push({ from: item.from, to: item.to, reason: "" });
            } catch (err) {
                errors.push(
                    `Failed to place "${item.from}" at "${item.to}": ${err instanceof Error ? err.message : err}`,
                );
                restoreStagedFile(projectPath, item, errors);
                continue;
            }

            // Database bookkeeping is non-fatal once the filesystem move has
            // landed. Never attempt to restore a staging file that no longer
            // exists merely because SQLite failed.
            try {
                db?.renameTestRecords(toNativePath(item.from), toNativePath(item.to));
            } catch (err) {
                errors.push(
                    `Moved "${item.from}" but failed to update test records: ${
                        err instanceof Error ? err.message : err
                    }`,
                );
            }
        }

        return applied;
    } finally {
        try {
            db?.close();
        } catch (err) {
            errors.push(
                `Failed to close organize database: ${err instanceof Error ? err.message : err}`,
            );
        }
        // Restore anything still staged if an unexpected exception interrupts
        // placement. This cannot protect against SIGKILL/power loss, but it
        // guarantees ordinary runtime failures do not strand test files.
        for (const item of staged) {
            if (fs.existsSync(item.stagingPath)) {
                restoreStagedFile(projectPath, item, errors);
            }
        }
    }
}

/** Put a staged file back at its original path rather than losing it. */
function restoreStagedFile(
    projectPath: string,
    item: { stagingPath: string; from: string },
    errors: string[],
): void {
    try {
        fs.renameSync(item.stagingPath, path.resolve(projectPath, item.from));
    } catch (err) {
        errors.push(
            `Could not restore "${item.from}" from its staging path "${item.stagingPath}": ${
                err instanceof Error ? err.message : err
            }. The file content is intact at the staging path.`,
        );
    }
}

/**
 * After the moves have landed, rewrite every relative import specifier in the
 * test directory that the moves invalidated: specifiers inside moved files
 * (their base directory changed) and specifiers in unmoved files that pointed
 * at a moved file. Returns the number of files rewritten.
 */
function rewriteRelativeImports(
    projectPath: string,
    testDirectory: string,
    applied: OrganizeMove[],
    errors: string[],
): number {
    const absRoot = path.resolve(projectPath, testDirectory);
    if (!fs.existsSync(absRoot)) return 0;

    const movedByOldPath = new Map<string, string>();
    const oldPathByNewPath = new Map<string, string>();
    for (const move of applied) {
        const from = toPosixPath(move.from);
        const to = toPosixPath(move.to);
        movedByOldPath.set(from, to);
        oldPathByNewPath.set(to, from);
    }

    let rewritten = 0;
    for (const abs of listTestDirectoryFiles(absRoot)) {
        const currentRel = toPosixPath(path.relative(projectPath, abs));
        // A moved file's imports were written relative to its OLD location.
        const originalRel = oldPathByNewPath.get(currentRel) ?? currentRel;

        try {
            const content = fs.readFileSync(abs, "utf-8");
            const result = rewriteFileImports(originalRel, currentRel, content, movedByOldPath);
            if (result.changed) {
                fs.writeFileSync(abs, result.content);
                rewritten++;
            }
        } catch (err) {
            errors.push(
                `Failed to rewrite imports in "${currentRel}": ${
                    err instanceof Error ? err.message : err
                }`,
            );
        }
    }
    return rewritten;
}
