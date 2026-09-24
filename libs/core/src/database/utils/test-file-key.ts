import * as path from "node:path";

/**
 * Canonical form for `test_file` keys in `test_outcomes` / `test_source_map`.
 */
export function normalizeTestFileKey(testFile: string): string {
    const posix = path.posix.normalize(testFile.split("\\").join("/"));
    return posix.startsWith("./") ? posix.slice(2) : posix;
}
