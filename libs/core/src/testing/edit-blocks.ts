/**
 * SEARCH/REPLACE edit blocks
 *
 * Lets the LLM edit *sections* of an existing test file instead of
 * regenerating the whole thing. The model emits one or more blocks:
 *
 *     <<<<<<< SEARCH
 *     <exact lines from the current file>
 *     =======
 *     <replacement lines>
 *     >>>>>>> REPLACE
 *
 * We apply them against the current file content by string matching
 * (exact first, then whitespace-tolerant), which is far more robust than
 * unified/git diffs — the model doesn't have to compute line numbers or
 * surrounding context precisely. Any block that can't be matched is
 * reported back so the caller can decide to warn the user or fall back to a
 * full-file rewrite.
 */

export interface EditBlock {
    search: string;
    replace: string;
}

export interface ApplyEditsResult {
    /** File content after applying every block that matched. */
    content: string;
    /** Number of blocks that were successfully applied. */
    appliedCount: number;
    /** Blocks whose SEARCH text could not be located in the file. */
    failedBlocks: EditBlock[];
    /**
     * Blocks whose SEARCH text matched MORE than once (ambiguous). These are not
     * applied — editing an arbitrary occurrence risks changing the wrong code.
     * They're a subset of `failedBlocks`.
     */
    ambiguousBlocks: EditBlock[];
}

const SEARCH_MARKER = /^<{5,9}\s*SEARCH\s*$/;
const DIVIDER_MARKER = /^={5,9}\s*$/;
const REPLACE_MARKER = /^>{5,9}\s*REPLACE\s*$/;

/**
 * Parse zero or more SEARCH/REPLACE blocks out of arbitrary model output.
 * Tolerant of surrounding prose and markdown fences. Returns [] when the
 * text contains no well-formed blocks (caller should then treat the text as
 * a full-file rewrite).
 */
export function parseEditBlocks(text: string): EditBlock[] {
    if (!text) return [];

    const lines = text.split("\n");
    const blocks: EditBlock[] = [];

    let state: "idle" | "search" | "replace" = "idle";
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        const trimmed = line.trim();

        if (state === "idle") {
            if (SEARCH_MARKER.test(trimmed)) {
                state = "search";
                searchLines = [];
                replaceLines = [];
            }
            continue;
        }

        if (state === "search") {
            if (DIVIDER_MARKER.test(trimmed)) {
                state = "replace";
                continue;
            }
            searchLines.push(line);
            continue;
        }

        // state === "replace"
        if (REPLACE_MARKER.test(trimmed)) {
            blocks.push({
                search: searchLines.join("\n"),
                replace: replaceLines.join("\n"),
            });
            state = "idle";
            searchLines = [];
            replaceLines = [];
            continue;
        }
        replaceLines.push(line);
    }

    return blocks;
}

/**
 * Strip stray SEARCH/REPLACE marker lines from text that is being treated as a
 * full-file rewrite. Guards the case where the model emitted a malformed block
 * (e.g. a `<<<<<<< SEARCH` with no closing `>>>>>>> REPLACE`): `parseEditBlocks`
 * finds no well-formed block, the caller falls back to using the raw text as a
 * full file, and without this the leftover marker lines would corrupt the spec.
 *
 * Only runs when a SEARCH/REPLACE marker is actually present, so a legitimate
 * file that happens to contain a `=======` divider line is left untouched.
 */
export function stripEditMarkers(text: string): string {
    const lines = text.split("\n");
    const hasBlockMarker = lines.some((l) => {
        const t = l.trim();
        return SEARCH_MARKER.test(t) || REPLACE_MARKER.test(t);
    });
    if (!hasBlockMarker) return text;
    return lines
        .filter((l) => {
            const t = l.trim();
            return !SEARCH_MARKER.test(t) && !DIVIDER_MARKER.test(t) && !REPLACE_MARKER.test(t);
        })
        .join("\n");
}

interface MatchRange {
    start: number;
    end: number;
}

/**
 * Locate `needle` inside `haystack`, returning character offsets. Tries an
 * exact substring match first, then a per-line trailing-whitespace-tolerant
 * match (handles the common case where the model reflows trailing spaces or
 * gets end-of-line whitespace slightly wrong). Returns null when neither
 * finds a unique-enough match.
 */
function findMatch(
    haystack: string,
    needle: string,
): { range: MatchRange | null; ambiguous: boolean } {
    if (needle.length === 0) return { range: null, ambiguous: false };

    // Exact match — require it to be UNIQUE. A SEARCH that appears twice is
    // ambiguous; editing an arbitrary occurrence could change the wrong code.
    const exact = haystack.indexOf(needle);
    if (exact !== -1) {
        const second = haystack.indexOf(needle, exact + 1);
        if (second !== -1) return { range: null, ambiguous: true };
        return { range: { start: exact, end: exact + needle.length }, ambiguous: false };
    }

    // Line-based, trailing-whitespace-tolerant fallback — also require unique.
    const hayLines = haystack.split("\n");
    const needleLines = needle.split("\n");
    const normHay = hayLines.map((l) => l.replace(/\s+$/, ""));
    const normNeedle = needleLines.map((l) => l.replace(/\s+$/, ""));

    if (normNeedle.length === 0) return { range: null, ambiguous: false };

    const matchStarts: number[] = [];
    for (let i = 0; i + normNeedle.length <= normHay.length; i++) {
        let matches = true;
        for (let j = 0; j < normNeedle.length; j++) {
            if (normHay[i + j] !== normNeedle[j]) {
                matches = false;
                break;
            }
        }
        if (matches) matchStarts.push(i);
    }

    if (matchStarts.length === 0) return { range: null, ambiguous: false };
    if (matchStarts.length > 1) return { range: null, ambiguous: true };

    const i = matchStarts[0];
    // Map the matched line window back to character offsets in the original
    // haystack (accounting for the '\n' separators).
    let start = 0;
    for (let k = 0; k < i; k++) {
        start += hayLines[k].length + 1;
    }
    let end = start;
    for (let k = 0; k < normNeedle.length; k++) {
        end += hayLines[i + k].length;
        if (k < normNeedle.length - 1) end += 1; // interior newline
    }
    return { range: { start, end }, ambiguous: false };
}

/**
 * Apply edit blocks to `original`, in order, each against the running
 * result. Blocks are applied at the first location their SEARCH text
 * matches. Unmatched blocks are collected in `failedBlocks` and leave the
 * content untouched so the caller can fall back to a full rewrite.
 */
export function applyEditBlocks(original: string, blocks: EditBlock[]): ApplyEditsResult {
    let content = original;
    let appliedCount = 0;
    const failedBlocks: EditBlock[] = [];
    const ambiguousBlocks: EditBlock[] = [];

    for (const block of blocks) {
        const { range, ambiguous } = findMatch(content, block.search);
        if (!range) {
            failedBlocks.push(block);
            if (ambiguous) ambiguousBlocks.push(block);
            continue;
        }
        content = content.slice(0, range.start) + block.replace + content.slice(range.end);
        appliedCount++;
    }

    return { content, appliedCount, failedBlocks, ambiguousBlocks };
}
