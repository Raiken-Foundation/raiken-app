/**
 * Minimal markdown-lite renderer for streamed assistant text — headers,
 * **bold**, `inline code`, bullet/numbered lists, and fenced code blocks get
 * lightweight ANSI styling so responses read like Claude Code's terminal
 * output instead of raw markdown source.
 *
 * Buffers per-line (flushing on every `\n`) rather than per-character: line
 * prefixes (`#`, `-`, ```` ``` ````) need the whole line to classify
 * correctly, and LLM chunks rarely straddle more than a line or two, so the
 * added latency is imperceptible while output stays correct.
 */
import chalk from "chalk";
import { accent, dim } from "../agent-stream";

function styleInline(text: string): string {
    let out = text.replace(/`([^`]+)`/g, (_m, code: string) => chalk.cyan(code));
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => chalk.bold(b));
    out = out.replace(/__([^_]+)__/g, (_m, b: string) => chalk.bold(b));
    return out;
}

function styleLine(line: string): string {
    const header = line.match(/^(#{1,6})\s+(.*)$/);
    if (header) {
        const level = header[1].length;
        const text = styleInline(header[2]);
        return level === 1 ? chalk.bold(accent(text)) : chalk.bold(text);
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
        return `${bullet[1]}${dim("•")} ${styleInline(bullet[2])}`;
    }

    const numbered = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
    if (numbered) {
        return `${numbered[1]}${accent(`${numbered[2]}${numbered[3]}`)} ${styleInline(numbered[4])}`;
    }

    return styleInline(line);
}

/**
 * Stateful line-buffered renderer: `push()` with raw streamed chunks, `end()`
 * once the turn finishes to flush any trailing partial line.
 */
export class MarkdownStream {
    private buffer = "";
    private inFence = false;

    /** Feed a raw chunk of streamed text; renders and writes complete lines. */
    push(chunk: string): void {
        this.buffer += chunk;
        let idx = this.buffer.indexOf("\n");
        while (idx !== -1) {
            this.emitLine(this.buffer.slice(0, idx));
            this.buffer = this.buffer.slice(idx + 1);
            idx = this.buffer.indexOf("\n");
        }
    }

    private emitLine(line: string): void {
        const fence = line.match(/^\s*```(\w*)\s*$/);
        if (fence) {
            this.inFence = !this.inFence;
            const lang = fence[1];
            process.stdout.write(dim(`  ┆${this.inFence && lang ? ` ${lang}` : ""}\n`));
            return;
        }
        if (this.inFence) {
            process.stdout.write(`${dim("  ┆ ")}${chalk.white(line)}\n`);
            return;
        }
        process.stdout.write(`${styleLine(line)}\n`);
    }

    /** Flush a trailing partial line (no trailing newline was ever seen). */
    end(): void {
        if (!this.buffer) return;
        process.stdout.write(
            this.inFence ? `${dim("  ┆ ")}${chalk.white(this.buffer)}` : styleLine(this.buffer),
        );
        this.buffer = "";
    }
}
