import { execFileSync } from "node:child_process";

/**
 * Changed-file listing for contract scoping and ci-style verification.
 * Reads `git diff --name-only <base>` (working tree included) with a
 * graceful fallback for non-git projects: an empty list means "nothing to
 * scope", which callers treat as "verify nothing / verify-all".
 */
export async function getChangedFiles(projectPath: string, base = "HEAD"): Promise<string[]> {
    try {
        const raw = execFileSync("git", ["diff", "--name-only", base], {
            cwd: projectPath,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}
