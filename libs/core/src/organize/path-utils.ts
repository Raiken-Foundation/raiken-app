/**
 * Path-separator conversion for `raiken organize`.
 *
 * Two different conventions meet in this module and must not be compared
 * directly:
 *   - Everywhere else test/source file paths are persisted (`test_source_map`,
 *     `test_outcomes`), they're written via `path.relative()`, which is
 *     OS-native — backslash-separated on Windows.
 *   - An LLM asked to move files around reliably answers with forward
 *     slashes regardless of host OS; that's the universal convention in
 *     prose/JSON, not the platform's own separator.
 * Comparing a native-separator inventory path against a forward-slash AI
 * proposal on Windows would silently reject every move (`"e2e\\login.spec.ts"`
 * !== `"e2e/login.spec.ts"`). Everything AI-facing in this module works in
 * forward-slash form; convert back to native only at the DB/filesystem
 * boundary.
 */

import * as path from "node:path";

export function toPosixPath(p: string): string {
    return p.split("\\").join("/");
}

export function toNativePath(p: string): string {
    return p.split("/").join(path.sep);
}
