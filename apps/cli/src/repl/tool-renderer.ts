import chalk from "chalk";
import { dim } from "../agent-stream";

/**
 * Collapses rapid tool-call spam into readable groups — Claude-style
 * "Called X 3 times" instead of flooding the transcript.
 *
 * Progress events still print immediately. Tool calls buffer for a short
 * window and flush as a single line when the tool name changes or the turn ends.
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
        const detail = summarizeArgs(args);
        if (this.verbose) {
            this.flush();
            process.stderr.write(dim(`   ⚙ ${toolName}${detail ? ` ${detail}` : ""}\n`));
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
        process.stderr.write(dim(`   … ${label}${detail ? ` ${detail}` : ""}\n`));
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
            process.stderr.write(dim(`   ⚙ ${name}${detail ? ` ${detail}` : ""}\n`));
        } else {
            process.stderr.write(
                dim(`   ⚙ ${name} ×${n}${detail ? `  ${chalk.dim(detail)}` : ""}\n`),
            );
        }
    }
}

function summarizeArgs(args: unknown): string {
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
    const value = typeof a.value === "string" ? ` = "${a.value}"` : "";
    const text = `${detail}${value}`;
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
