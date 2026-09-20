import * as path from "node:path";
import { resolvePathWithinProject } from "../../../config";

/**
 * Paths inside `.raiken/` are the tool's own state: `auth-state.json` holds
 * live session cookies (chmod 600) and the SQLite DBs hold crawl data. The
 * model must never read them via readFile/listDirectory — the content would
 * flow into model context and transcripts unredacted (review finding).
 */
const RAIKEN_STATE_DIR = `${path.sep}.raiken${path.sep}`;

function isRaikenStatePath(resolved: string): boolean {
    return resolved.includes(RAIKEN_STATE_DIR);
}

/**
 * Ensure a relative file path stays within the project root AND outside the
 * agent's own state directory. Throws if the resolved path escapes either.
 */
export function safePath(projectPath: string, filePath: string): string {
    try {
        const resolved = resolvePathWithinProject(projectPath, filePath);
        if (isRaikenStatePath(resolved)) {
            throw new Error(
                `Access to Raiken internal state is denied: ${filePath}. Read application source files instead.`,
            );
        }
        return resolved;
    } catch (error) {
        if (error instanceof Error && error.message.includes("Raiken internal state")) {
            throw error;
        }
        throw new Error(`Path traversal denied: ${filePath}`);
    }
}
