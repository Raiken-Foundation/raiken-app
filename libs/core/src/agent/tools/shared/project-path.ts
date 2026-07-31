import { resolvePathWithinProject } from "../../../config";

/**
 * Ensure a relative file path stays within the project root.
 * Throws if the resolved path escapes the project directory.
 */
export function safePath(projectPath: string, filePath: string): string {
    try {
        return resolvePathWithinProject(projectPath, filePath);
    } catch {
        throw new Error(`Path traversal denied: ${filePath}`);
    }
}
