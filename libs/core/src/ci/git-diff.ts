/**
 * Git diff helpers for `raiken ci`.
 *
 * Resolves base/head refs and turns `git diff --name-status` output into a
 * structured list of changed files. All git calls are sync (execSync) because
 * they are small and we want deterministic ordering before the rest of the
 * pipeline runs.
 */

import { execSync } from "node:child_process";
import type { CiChangedFile, CiChangedFileStatus, ResolvedRefs } from "./types";

class GitError extends Error {
    constructor(
        message: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = "GitError";
    }
}

export { GitError };

function runGit(args: string[], cwd: string): string {
    try {
        return execSync(`git ${args.join(" ")}`, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new GitError(`git ${args.join(" ")} failed: ${msg}`, err);
    }
}

function revExists(ref: string, cwd: string): boolean {
    try {
        execSync(`git rev-parse --verify --quiet ${quote(ref)}`, {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
    } catch {
        return false;
    }
}

function quote(ref: string): string {
    // Safe because ref values come from the CLI / our own defaults; still
    // wrap in single quotes to guard against spaces and shell metachars.
    return `'${ref.replace(/'/g, "'\\''")}'`;
}

/**
 * Pick a sensible default base ref when the user does not pass `--base`.
 *
 * Preference order:
 *   1. GITHUB_BASE_REF (set by GitHub Actions on pull requests)
 *   2. origin/main
 *   3. origin/master
 *   4. main
 *   5. master
 *   6. HEAD~1 (fallback; single-commit diff)
 */
export function defaultBaseRef(projectPath: string): string {
    const githubBase = process.env["GITHUB_BASE_REF"];
    if (githubBase && revExists(`origin/${githubBase}`, projectPath)) {
        return `origin/${githubBase}`;
    }
    if (githubBase && revExists(githubBase, projectPath)) {
        return githubBase;
    }
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
        if (revExists(ref, projectPath)) return ref;
    }
    return "HEAD~1";
}

export function resolveRefs(
    projectPath: string,
    base: string | undefined,
    head: string | undefined,
): ResolvedRefs {
    const baseRef = base || defaultBaseRef(projectPath);
    const headRef = head || "HEAD";

    if (!revExists(baseRef, projectPath)) {
        throw new GitError(
            `Base ref "${baseRef}" not found. Pass --base <ref> or fetch the branch first.`,
        );
    }
    if (!revExists(headRef, projectPath)) {
        throw new GitError(`Head ref "${headRef}" not found.`);
    }

    const baseSha = runGit(["rev-parse", quote(baseRef)], projectPath);
    const headSha = runGit(["rev-parse", quote(headRef)], projectPath);

    return { base: baseRef, baseSha, head: headRef, headSha };
}

/**
 * Get the list of files changed between `base` and `head`.
 *
 * Uses `--name-status -M` so renames are detected as `R<score>` and we can
 * preserve the previous path. Output is stable — no sorting applied beyond
 * git's own ordering.
 */
export function getChangedFiles(projectPath: string, refs: ResolvedRefs): CiChangedFile[] {
    const raw = runGit(
        // `-M` already enables rename detection (renames show as `R<score>`).
        // Don't add `--no-renames=false` — git rejects it (the flag takes no value).
        // `--relative` + the `-- .` pathspec scope the diff to the raiken
        // PROJECT (the cwd) rather than the whole containing git repo, and emit
        // paths relative to that project so they match the code-graph keys.
        [
            "diff",
            "--name-status",
            "-M",
            "--relative",
            `${quote(refs.base)}...${quote(refs.head)}`,
            "--",
            ".",
        ],
        projectPath,
    );

    if (!raw) return [];

    const files: CiChangedFile[] = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;

        const code = parts[0];
        const statusLetter = code[0];
        const status = mapStatus(statusLetter);
        if (!status) continue;

        if ((statusLetter === "R" || statusLetter === "C") && parts.length >= 3) {
            files.push({ path: parts[2], previousPath: parts[1], status });
        } else {
            files.push({ path: parts[1], status });
        }
    }
    return files;
}

/**
 * Get the list of files currently staged in the working tree (index vs HEAD).
 * Used by `raiken ci --staged` to run impact analysis on a pre-commit snapshot
 * without requiring a base ref.
 */
export function getStagedFiles(projectPath: string): CiChangedFile[] {
    const raw = runGit(
        ["diff", "--cached", "--name-status", "-M", "--relative", "--", "."],
        projectPath,
    );
    if (!raw) return [];

    const files: CiChangedFile[] = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;

        const statusLetter = parts[0][0];
        const status = mapStatus(statusLetter);
        if (!status) continue;

        if ((statusLetter === "R" || statusLetter === "C") && parts.length >= 3) {
            files.push({ path: parts[2], previousPath: parts[1], status });
        } else {
            files.push({ path: parts[1], status });
        }
    }
    return files;
}

function mapStatus(letter: string): CiChangedFileStatus | null {
    switch (letter) {
        case "A":
            return "added";
        case "M":
            return "modified";
        case "D":
            return "removed";
        case "R":
            return "renamed";
        case "C":
            return "copied";
        case "T":
            return "modified";
        default:
            return null;
    }
}

/**
 * Subset of changed files the impact analyser should consider: anything
 * that still exists at `head` (so deletions and files under irrelevant
 * extensions drop out). Kept deliberately permissive — test files can
 * import non-source assets, and GraphQueryService does its own filtering.
 */
export function filterSourceFiles(files: CiChangedFile[]): string[] {
    const result: string[] = [];
    for (const f of files) {
        if (f.status === "removed") continue;
        result.push(f.path);
    }
    return result;
}
