/**
 * Blank regions of a source file without moving anything that remains.
 *
 * Every masked character becomes a space and every newline is kept, so offsets
 * and line numbers in the masked copy still match the original file. That is
 * what lets a single Babel parse cover both `<script>` blocks of a Vue SFC and
 * still report the true file line for each symbol, and lets template scanning
 * skip comments without shifting the lines it reports.
 */

function blank(text: string): string {
    return text.replace(/[^\n]/g, " ");
}

/** Blank every match of `pattern`. */
export function maskMatches(code: string, pattern: RegExp): string {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    return code.replace(new RegExp(pattern.source, flags), blank);
}

export interface SourceRegion {
    start: number;
    end: number;
}

/** Blank everything outside the given regions. */
export function maskOutside(code: string, keep: SourceRegion[]): string {
    if (keep.length === 0) return blank(code);

    const ordered = [...keep].sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;

    for (const region of ordered) {
        const start = Math.max(cursor, region.start);
        if (start > cursor) out += blank(code.slice(cursor, start));
        if (region.end > start) {
            out += code.slice(start, region.end);
            cursor = region.end;
        }
    }

    if (cursor < code.length) out += blank(code.slice(cursor));
    return out;
}
