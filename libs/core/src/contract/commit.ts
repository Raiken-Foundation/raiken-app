import { execFileSync } from "node:child_process";

/**
 * Git is the version history of the code; the contract ledger is the history
 * of the app's behavior. Stamping every ledger event with the commit it was
 * observed at joins the two: "what behavior changed between these commits" is
 * a query, not an archaeology exercise.
 */

export interface CommitStamp {
    sha: string;
    /**
     * The working tree had uncommitted changes under the project when the event
     * was recorded, so the observation belongs to "HEAD plus local edits", not
     * to `sha` itself.
     */
    dirty: boolean;
}

export interface CommitInfo {
    sha: string;
    subject: string;
    /** Commit time, epoch ms. */
    committedAt: number;
}

export class GitRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GitRangeError";
    }
}

function git(projectPath: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
    }).trim();
}

/** HEAD and whether the project has local changes; null outside a git repo. */
export function readCommitStamp(projectPath: string): CommitStamp | null {
    try {
        const sha = git(projectPath, ["rev-parse", "HEAD"]);
        if (!/^[0-9a-f]{40}$/.test(sha)) return null;
        // Scoped to the project directory; untracked files count (a new
        // component changes behavior before anyone runs `git add`).
        const status = git(projectPath, ["status", "--porcelain", "--", "."]);
        return { sha, dirty: status.length > 0 };
    } catch {
        return null;
    }
}

/**
 * Commits in a git range, oldest first. Accepts `a..b`, `a...b` (read as the
 * commits reachable from b and not a), or a single ref (read as `ref..HEAD`).
 */
export function commitsInRange(projectPath: string, range: string): CommitInfo[] {
    const spec = range.includes("..") ? range.replace("...", "..") : `${range}..HEAD`;
    // The range can come from an MCP client: never let it reach git as an
    // option (`--output=<file>` would write anywhere).
    if (spec.split("..").some((side) => side.trim().startsWith("-"))) {
        throw new GitRangeError(`invalid git range "${range}": refs cannot start with "-"`);
    }
    let raw: string;
    try {
        raw = git(projectPath, ["log", "--reverse", "--format=%H%x1f%ct%x1f%s", spec]);
    } catch (error) {
        const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
        throw new GitRangeError(
            `invalid git range "${range}"${stderr ? `: ${stderr.split("\n")[0]}` : ""}`,
        );
    }
    if (!raw) return [];
    return raw.split("\n").map((line) => {
        const [sha, ct, ...subject] = line.split("\u001f");
        return { sha, subject: subject.join("\u001f"), committedAt: Number(ct) * 1000 };
    });
}

/** Resolve a ref to its full SHA, or null. */
export function resolveCommit(projectPath: string, ref: string): string | null {
    try {
        const sha = git(projectPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
        return null;
    }
}
