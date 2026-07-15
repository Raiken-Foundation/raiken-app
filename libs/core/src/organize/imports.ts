/**
 * Relative-import rewriting for `raiken organize` file moves.
 *
 * Moving a file breaks two classes of references: the relative specifiers
 * *inside* the moved file (`./fixtures`, `../pages/login-page`) and the
 * relative specifiers *in other files* that point at it. Both must be
 * rewritten or the suite fails to compile the moment it's "organized".
 *
 * Regex-based on purpose — same trade-off as inventory.ts: these are import
 * lines in test files, not arbitrary TS, and a full parser buys little here.
 */

import * as path from "node:path";

/**
 * Captures the specifier of static `import ... from`, `export ... from`,
 * side-effect `import "..."`, dynamic `import("...")` and `require("...")`.
 * Only relative specifiers (`./` or `../`) are captured — bare/module
 * specifiers are unaffected by file moves.
 */
const RELATIVE_SPECIFIER_PATTERN =
    /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"'\n]*)\2/g;

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Rewrite the relative import specifiers of one file so they still resolve
 * after a set of moves has been applied.
 *
 * All paths are POSIX-style and project-relative.
 *
 * @param fileOldPath where the file lived when its imports were written
 * @param fileNewPath where the file lives now (same as `fileOldPath` when the
 *   file itself didn't move but other files it references did)
 * @param content the file's current content
 * @param movedByOldPath map of every applied move: old path -> new path
 */
export function rewriteFileImports(
    fileOldPath: string,
    fileNewPath: string,
    content: string,
    movedByOldPath: Map<string, string>,
): { content: string; changed: boolean } {
    const oldDir = path.posix.dirname(fileOldPath);
    const newDir = path.posix.dirname(fileNewPath);
    let changed = false;

    const rewritten = content.replace(
        RELATIVE_SPECIFIER_PATTERN,
        (full, prefix: string, quote: string, spec: string) => {
            // Project-relative form of what the specifier pointed at from the
            // file's ORIGINAL location (specifiers may be extensionless).
            const resolvedRaw = path.posix.normalize(path.posix.join(oldDir, spec));

            let targetRaw: string | null = null;
            const exact = movedByOldPath.get(resolvedRaw);
            if (exact) {
                targetRaw = exact;
            } else {
                // Extensionless specifier pointing at a moved file: sanitizeMoves
                // guarantees moves keep their extension, so the new specifier
                // can stay extensionless too.
                for (const ext of RESOLVABLE_EXTENSIONS) {
                    const mapped = movedByOldPath.get(resolvedRaw + ext);
                    if (mapped) {
                        targetRaw = mapped.slice(0, -ext.length);
                        break;
                    }
                }
            }
            if (targetRaw === null) targetRaw = resolvedRaw;

            let newSpec = path.posix.relative(newDir, targetRaw);
            if (!newSpec.startsWith(".")) newSpec = `./${newSpec}`;
            if (newSpec === spec) return full;

            changed = true;
            return `${prefix}${quote}${newSpec}${quote}`;
        },
    );

    return { content: rewritten, changed };
}
