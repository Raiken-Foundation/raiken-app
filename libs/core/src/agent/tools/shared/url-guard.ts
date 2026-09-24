/**
 * URL scheme guard for model-authored navigation targets.
 *
 * zod's `z.string().url()` accepts `file:`, `javascript:`, and `data:`
 * schemes — and graph-node callers bypass zod entirely (they call
 * `tool.execute` directly). Every tool that points the real browser at a
 * URL must enforce the http/https allowlist inside `execute` so validation
 * holds regardless of the caller (review finding: agent-tools guardrails).
 */

export function assertHttpUrl(url: string, label = "URL"): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid ${label}: "${url}" is not a parseable URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
            `Invalid ${label}: "${parsed.protocol}" scheme is not allowed — only http and https URLs can be navigated.`,
        );
    }
}
