import chalk from "chalk";
import { dim } from "../agent-stream";

/**
 * Collapses rapid tool-call spam into readable groups — Claude-style
 * "Called X 3 times" instead of flooding the transcript.
 *
 * Progress events still print immediately. Tool calls buffer for a short
 * window and flush as a single line when the tool name changes or the turn ends.
 *
 * Rendering mirrors Claude Code's transcript: a bright `⏺` bullet + bold tool
 * name for the call itself, with an indented `⎿` line underneath for the
 * progress note that belongs to it (when one follows).
 */
export class ToolCallRenderer {
    private lastTool: string | null = null;
    private count = 0;
    private lastDetail = "";
    private verbose: boolean;

    constructor(options: { verbose?: boolean } = {}) {
        this.verbose = options.verbose ?? false;
    }

    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }

    onToolCall(toolName: string, args: unknown): void {
        const detail = summarizeArgs(toolName, args);
        if (this.verbose) {
            this.flush();
            process.stderr.write(callLine(toolName, detail));
            return;
        }

        if (this.lastTool === toolName) {
            this.count += 1;
            this.lastDetail = detail || this.lastDetail;
            return;
        }

        this.flush();
        this.lastTool = toolName;
        this.count = 1;
        this.lastDetail = detail;
    }

    onProgress(label: string, detail?: string | null): void {
        this.flush();
        process.stderr.write(dim(`  ⎿ ${label}${detail ? ` ${detail}` : ""}\n`));
    }

    /** Flush any buffered tool group. Call at end of turn / before HITL. */
    flush(): void {
        if (!this.lastTool || this.count === 0) {
            this.lastTool = null;
            this.count = 0;
            return;
        }
        const name = this.lastTool;
        const n = this.count;
        const detail = this.lastDetail;
        this.lastTool = null;
        this.count = 0;
        this.lastDetail = "";

        if (n === 1) {
            process.stderr.write(callLine(name, detail));
        } else {
            process.stderr.write(callLine(name, detail, n));
        }
    }
}

/** `⏺ toolName  detail` (or `⏺ toolName ×N  detail` when collapsed). */
function callLine(name: string, detail: string, count = 1): string {
    const bullet = chalk.hex("#a78bfa")("⏺");
    const label = chalk.bold.white(name) + (count > 1 ? chalk.bold.white(` ×${count}`) : "");
    return `  ${bullet} ${label}${detail ? `  ${dim(detail)}` : ""}\n`;
}

function summarizeArgs(toolName: string, args: unknown): string {
    const a = (args ?? {}) as Record<string, unknown>;
    const detail =
        (typeof a.url === "string" && a.url) ||
        (typeof a.selector === "string" && a.selector) ||
        (Array.isArray(a.selector) && a.selector.join(" | ")) ||
        (typeof a.query === "string" && a.query) ||
        (typeof a.path === "string" && a.path) ||
        (typeof a.filePath === "string" && a.filePath) ||
        (typeof a.label === "string" && a.label) ||
        "";
    const value =
        typeof a.value === "string"
            ? ` = "${toolName === "fillInput" || toolName === "typeText" ? "[REDACTED]" : a.value}"`
            : "";
    const text = `${detail}${value}`;
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
