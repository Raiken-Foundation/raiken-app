import { parseSourceFile } from "../analysis/ast-parser";
import { inspectTestAssertions } from "./assertion-contract";

export interface TestCodeValidation {
    ok: boolean;
    /** Reviewer-readable reason, present only when `ok` is false. */
    reason?: string;
}

/**
 * Tool-call markup that leaked out of the model's answer instead of being
 * executed: `<function_calls>`, `<invoke name="…">`, `<parameter name="…">`,
 * `<tool_call>`.
 *
 * This must be matched explicitly rather than left to the parser, because
 * {@link parseSourceFile} always enables Babel's JSX plugin — so a blob of
 * pseudo-XML parses as a perfectly valid JSX expression. Combined with the
 * word `test(` appearing anywhere inside it, such a blob would otherwise pass
 * for a test file and land on disk as a spec that exercises nothing.
 */
const TOOL_TAG_PATTERN = /<\/?(?:function_calls|invoke|parameter|tool_call|antml:[a-z_]+)\b/i;

/** `test(`, `test.describe(`, `test.only(`, `test.skip(`, `test.fixme(`. */

/**
 * The single gate every path that writes a spec to disk must clear.
 *
 * A streamed response cut off mid-token, an empty/near-empty reply, prose
 * instead of code, or a leaked tool-call transcript would otherwise flow
 * straight through to a file — generation's `hitlSave` only checks
 * `if (!state.testDraft)`, and repair's extraction only looked for a fenced
 * block, so any truthy-but-garbage string passed both. Real parsing (not
 * brace counting, which string literals defeat) catches truncation
 * reliably, and the `test(`-call check catches output that parses but
 * exercises nothing (a lone comment, a bare import).
 *
 * Shared by generation and repair so an identical blob is accepted or
 * rejected identically no matter which produced it.
 */
export function validateTestCode(code: string): TestCodeValidation {
    if (!code.trim()) return { ok: false, reason: "empty response" };
    if (TOOL_TAG_PATTERN.test(code)) {
        return { ok: false, reason: "contains tool-call markup instead of test code" };
    }
    try {
        parseSourceFile(code, "generated-test.spec.ts");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `does not parse as valid JS/TS (${message})` };
    }
    if (inspectTestAssertions(code).tests === 0) {
        return { ok: false, reason: "no Playwright test() call found" };
    }
    return { ok: true };
}
