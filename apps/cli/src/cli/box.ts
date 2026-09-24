/**
 * Claude Code-style rounded box drawing for the banner, plan preview, and
 * HITL cards. Kept dependency-free (just chalk) so it's cheap to import from
 * `bin.ts` before the heavy `@raiken/core` barrel loads.
 */
import { accent, dim } from "../agent-stream";

// Built from a char code (rather than a literal \x1b escape) to avoid the
// "control character in regex" lint while still matching ANSI SGR codes.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleLength(s: string): number {
    return s.replace(ANSI_PATTERN, "").length;
}

const ANSI_RESET = `${String.fromCharCode(27)}[0m`;

/**
 * Clip a styled line to `max` VISIBLE characters: escape sequences pass
 * through without counting (and are never cut mid-sequence), and a reset is
 * appended so a style opened before the cut can't bleed past the box wall.
 */
function clipVisible(line: string, max: number): string {
    let out = "";
    let visible = 0;
    let i = 0;
    while (i < line.length && visible < max) {
        ANSI_PATTERN.lastIndex = i;
        const match = ANSI_PATTERN.exec(line);
        if (match && match.index === i) {
            out += match[0];
            i += match[0].length;
            continue;
        }
        out += line[i];
        visible++;
        i++;
    }
    return out + ANSI_RESET;
}

/** Terminal-width-aware box width, clamped to a readable range. */
export function boxWidth(): number {
    const cols = process.stdout.columns || 80;
    return Math.min(Math.max(cols - 4, 44), 96);
}

/**
 * Render a rounded box around the given lines (already ANSI-styled if
 * desired — width accounting strips escape codes so colored text still
 * lines up). Pass "" for a blank spacer row.
 */
export function renderBox(lines: string[], width: number = boxWidth()): string {
    const inner = width - 4; // "│ " + content + " │"
    const top = dim(`╭${"─".repeat(width - 2)}╮`);
    const bottom = dim(`╰${"─".repeat(width - 2)}╯`);
    const body = lines.map((line) => {
        const visible = visibleLength(line);
        const clipped = visible > inner ? clipVisible(line, inner) : line;
        const pad = Math.max(0, inner - visibleLength(clipped));
        return `${dim("│")} ${clipped}${" ".repeat(pad)} ${dim("│")}`;
    });
    return [top, ...body, bottom].join("\n");
}

/**
 * Input dividers deliberately have no side walls. Node readline owns and
 * redraws the editable row, so a fixed right wall cannot stay aligned while
 * the user types or wraps. Full-width rails look intentional at every width
 * instead of leaving the composer visibly open on the right.
 */
export function promptTopBorder(width: number = boxWidth()): string {
    return dim("─".repeat(width));
}

export function promptBottomBorder(width: number = boxWidth()): string {
    return dim("─".repeat(width));
}

/** Prompt glyph used on readline's editable row. */
export function promptPrefix(continuation = false): string {
    return continuation ? `  ${dim("…")} ` : `${accent("›")} `;
}
