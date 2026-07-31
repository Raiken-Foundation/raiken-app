/**
 * Minimal unified-diff renderer for the CLI repair flow (`raiken repair`,
 * `raiken test --fix`). The dashboard gets a Monaco diff editor; the
 * terminal gets this — LCS over lines, grouped into hunks with context,
 * colored like `git diff`.
 */

import chalk from "chalk";

export interface UnifiedDiffOptions {
    /** Context lines around each change (default 3). */
    context?: number;
    fromLabel?: string;
    toLabel?: string;
    /** Disable ANSI colors (JSON payloads, snapshots). */
    plain?: boolean;
}

interface DiffOp {
    kind: "context" | "del" | "add";
    line: string;
}

/** Longest-common-subsequence alignment of two line arrays. */
function align(a: string[], b: string[]): DiffOp[] {
    const n = a.length;
    const m = b.length;
    // dp[i][j] = LCS length of a[i:] and b[j:]
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i] ?? [];
        const nextRow = dp[i + 1] ?? [];
        for (let j = m - 1; j >= 0; j--) {
            row[j] =
                a[i] === b[j]
                    ? (nextRow[j + 1] ?? 0) + 1
                    : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
        }
        dp[i] = row;
    }
    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const ai = a[i];
        const bj = b[j];
        if (ai === undefined || bj === undefined) break;
        if (ai === bj) {
            ops.push({ kind: "context", line: ai });
            i++;
            j++;
        } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
            ops.push({ kind: "del", line: ai });
            i++;
        } else {
            ops.push({ kind: "add", line: bj });
            j++;
        }
    }
    while (i < n) {
        const line = a[i++];
        if (line !== undefined) ops.push({ kind: "del", line });
    }
    while (j < m) {
        const line = b[j++];
        if (line !== undefined) ops.push({ kind: "add", line });
    }
    return ops;
}

/**
 * Render `original` → `proposed` as a unified diff. Returns an empty string
 * when the inputs are identical (callers treat that as "no changes").
 */
export function formatUnifiedDiff(
    original: string,
    proposed: string,
    options: UnifiedDiffOptions = {},
): string {
    if (original === proposed) return "";
    const context = options.context ?? 3;
    const ops = align(original.split("\n"), proposed.split("\n"));

    // Mark ops inside hunks: any change plus `context` neighbors on each side.
    const included = new Array<boolean>(ops.length).fill(false);
    ops.forEach((op, index) => {
        if (op.kind === "context") return;
        for (
            let k = Math.max(0, index - context);
            k <= Math.min(ops.length - 1, index + context);
            k++
        ) {
            included[k] = true;
        }
    });

    const paint = {
        del: (s: string) => (options.plain ? s : chalk.red(s)),
        add: (s: string) => (options.plain ? s : chalk.green(s)),
        meta: (s: string) => (options.plain ? s : chalk.cyan(s)),
        header: (s: string) => (options.plain ? s : chalk.bold(s)),
    };

    const lines: string[] = [
        paint.header(`--- ${options.fromLabel ?? "a/spec"}`),
        paint.header(`+++ ${options.toLabel ?? "b/spec"}`),
    ];

    // Walk hunks: contiguous included runs; track old/new line numbers.
    let oldLine = 1;
    let newLine = 1;
    let index = 0;
    while (index < ops.length) {
        const op = ops[index];
        if (!op) break;
        if (!included[index]) {
            if (op.kind !== "add") oldLine++;
            if (op.kind !== "del") newLine++;
            index++;
            continue;
        }
        const hunkOldStart = oldLine;
        const hunkNewStart = newLine;
        const hunkLines: string[] = [];
        let oldCount = 0;
        let newCount = 0;
        while (index < ops.length && included[index]) {
            const current = ops[index];
            if (!current) break;
            if (current.kind === "context") {
                hunkLines.push(` ${current.line}`);
                oldCount++;
                newCount++;
                oldLine++;
                newLine++;
            } else if (current.kind === "del") {
                hunkLines.push(paint.del(`-${current.line}`));
                oldCount++;
                oldLine++;
            } else {
                hunkLines.push(paint.add(`+${current.line}`));
                newCount++;
                newLine++;
            }
            index++;
        }
        lines.push(
            paint.meta(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`),
            ...hunkLines,
        );
    }

    return lines.join("\n");
}
