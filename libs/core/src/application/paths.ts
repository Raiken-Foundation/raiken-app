import { resolvePathWithinProject } from "../config/store";

export { writeFileAtomic } from "../io/atomic-write";

/**
 * Resolve `candidate` under `projectPath`, rejecting traversal escapes.
 */
export function assertUnderProjectRoot(candidate: string, projectPath: string): string {
    return resolvePathWithinProject(projectPath, candidate);
}
