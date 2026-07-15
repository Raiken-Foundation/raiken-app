import readline from "node:readline";
import { renderSlashMenu, shouldShowSlashMenu } from "./completer";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleLength(value: string): number {
    return value.replace(ANSI_PATTERN, "").length;
}

export interface SlashOverlayState {
    enabled: boolean;
    line: string;
    cursor: number;
    cursorRows: number;
    prompt: string;
}

/**
 * Ephemeral slash-command menu drawn above readline's editable row.
 *
 * The controller tracks exactly how many rows it owns, erases only those
 * rows, and redraws readline's prompt/buffer after every update. It hides for
 * arguments and wrapped input, where cursor accounting would otherwise become
 * fragile across terminal implementations.
 */
export class SlashMenuOverlay {
    private renderedRows = 0;

    constructor(private readonly output: NodeJS.WriteStream = process.stdout) {}

    sync(state: SlashOverlayState): void {
        const columns = this.output.columns || 80;
        const fitsOneLine = visibleLength(state.prompt) + state.line.length < columns;
        const visible = state.enabled && fitsOneLine && shouldShowSlashMenu(state.line);

        if (!visible) {
            this.hide(state);
            return;
        }

        const menu = renderSlashMenu(state.line, columns);
        this.eraseCurrentLayout(state.cursorRows);
        this.output.write(`${menu.join("\n")}\n`);
        this.redrawInput(state);
        this.renderedRows = menu.length;
    }

    /** Remove the menu while preserving the current editable input. */
    hide(state: SlashOverlayState): void {
        if (this.renderedRows === 0) return;
        this.eraseCurrentLayout(state.cursorRows);
        this.redrawInput(state);
        this.renderedRows = 0;
    }

    /**
     * Called after readline accepts a line. At this point the cursor is one row
     * below the submitted input, so erase the overlay and replay only the
     * submitted prompt line into scrollback.
     */
    finish(prompt: string, line: string): void {
        if (this.renderedRows === 0) return;
        readline.moveCursor(this.output, 0, -(this.renderedRows + 1));
        readline.cursorTo(this.output, 0);
        readline.clearScreenDown(this.output);
        this.output.write(`${prompt}${line}\n`);
        this.renderedRows = 0;
    }

    reset(): void {
        this.renderedRows = 0;
    }

    get visible(): boolean {
        return this.renderedRows > 0;
    }

    private eraseCurrentLayout(cursorRows: number): void {
        readline.cursorTo(this.output, 0);
        const rowsUp = this.renderedRows + Math.max(0, cursorRows);
        if (rowsUp > 0) readline.moveCursor(this.output, 0, -rowsUp);
        readline.clearScreenDown(this.output);
    }

    private redrawInput(state: SlashOverlayState): void {
        this.output.write(`${state.prompt}${state.line}`);
        const suffixLength = state.line.length - state.cursor;
        if (suffixLength > 0) readline.moveCursor(this.output, -suffixLength, 0);
    }
}
