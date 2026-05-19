/**
 * Test Result Interpreter
 *
 * Uses an LLM to analyze Playwright test results and produce a grounded,
 * actionable explanation of what failed and how to fix it.
 *
 * Design principle: the prompt MUST contain enough concrete evidence
 * (Playwright `Call log:` lines, error messages, attachment names, raw
 * output excerpts) that the model can ground every claim. Pre-fix the
 * dashboard was sending only the structured top-line `error.message` plus
 * the test source — the model had no way to distinguish "selector
 * mismatch" from "page not loaded" from "click intercepted by overlay"
 * because all three produce the same timeout, and was inventing
 * explanations that diverged from the on-disk artifacts.
 *
 * Context-gap remediations applied here:
 *  1. {@link TestResultForInterpretation.attachments} — pass through
 *     screenshot / video / trace metadata so the model can reference
 *     specific artifacts ("the test-failed-1.png screenshot would
 *     confirm…").
 *  2. {@link InterpretationContext.rawOutput} — Playwright stdout/stderr
 *     including the full per-action call log. Truncated tail-first to
 *     keep token cost bounded.
 *  3. {@link InterpretationContext.testFilePath} — bound the test code
 *     to a known file so the prompt can call out a context mismatch
 *     when the model can't find the failing locator in the supplied
 *     code.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText } from "ai";
import type { DOMContext } from "../browser/dom-capture";

export interface InterpretationAttachment {
    name: string;
    contentType?: string;
    path?: string;
}

export interface TestResultForInterpretation {
    name: string;
    suite: string;
    status: "passed" | "failed" | "skipped";
    duration?: number;
    error?: {
        message?: string;
        snippet?: string;
        location?: {
            file: string;
            line: number;
            column: number;
        };
    };
    /**
     * Per-test artifacts captured by the Playwright reporter (failure
     * screenshot, video, trace, etc.). Not inlined as bytes; we just
     * surface the filenames + content types so the model can reference
     * them by name and recommend opening them when its diagnosis would
     * benefit from visual confirmation.
     */
    attachments?: InterpretationAttachment[];
}

export interface InterpretationContext {
    testResults: TestResultForInterpretation[];
    testCode: string;
    /**
     * Absolute or repo-relative path of the file whose results are being
     * interpreted. Optional but strongly recommended — when present the
     * prompt explicitly anchors `testCode` to this path and asks the
     * model to flag mismatches (a common mode where a stale editor tab
     * sent the wrong file).
     */
    testFilePath?: string;
    /**
     * Raw Playwright stdout/stderr from the run. Contains the full per-
     * action `Call log:` and any console messages emitted by the page.
     * The prompt builder takes a tail-first slice up to
     * {@link RAW_OUTPUT_BUDGET_CHARS} so the most-recent (and most-
     * relevant) lines survive truncation.
     */
    rawOutput?: string;
    sourceCode?: string;
    domContext?: DOMContext;
    projectPath: string;
}

export interface InterpretationConfig {
    apiKey: string;
    model?: string;
}

// ---------------------------------------------------------------------------
// Token budget knobs. Conservative defaults sized for Sonnet-4.5's 200k
// context with significant headroom for streaming output. Tune downward
// for cheaper models if cost/latency becomes an issue.
// ---------------------------------------------------------------------------

const TEST_CODE_BUDGET_CHARS = 6000;
const SOURCE_CODE_BUDGET_CHARS = 2500;
const RAW_OUTPUT_BUDGET_CHARS = 6000;
const ERROR_MESSAGE_BUDGET_CHARS = 4000;
const MAX_ATTACHMENTS_PER_TEST = 8;

/**
 * Strip ANSI colour codes that Playwright embeds in error messages.
 * Keeps the prompt readable and saves a non-trivial number of tokens
 * on long stack traces.
 *
 * The literal ESC (`\u001b`) is the whole point of the pattern — we're
 * matching ANSI escape sequences — so the lint rule about control
 * characters in regexes is the wrong call here.
 */
function stripAnsi(input: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes by construction
    return input.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Truncate keeping the TAIL — for raw test output, the most actionable
 * content (failed action, call log, final summary) lives at the end.
 * Truncating from the head would drop exactly the lines we want.
 */
function truncateTail(input: string, budget: number): string {
    if (input.length <= budget) return input;
    return `…[truncated ${input.length - budget} earlier chars]…\n${input.slice(-budget)}`;
}

/**
 * Truncate keeping the HEAD — for source code, structure (imports,
 * top-level declarations, hook setup) at the top of the file is more
 * informative than the tail.
 */
function truncateHead(input: string, budget: number): string {
    if (input.length <= budget) return input;
    return `${input.slice(0, budget)}\n…[truncated ${input.length - budget} trailing chars]…`;
}

/**
 * Format an attachment line for the prompt. We annotate with a short
 * human-readable hint about WHAT the attachment proves, because the
 * model often won't know that `test-failed-1.png` is captured at the
 * exact moment of timeout vs. arbitrarily during the run.
 */
function describeAttachment(att: InterpretationAttachment): string {
    const role = inferAttachmentRole(att);
    const type = att.contentType ? ` (${att.contentType})` : "";
    return `- ${att.name}${type}${role ? ` — ${role}` : ""}`;
}

function inferAttachmentRole(att: InterpretationAttachment): string {
    const name = att.name.toLowerCase();
    const ct = (att.contentType ?? "").toLowerCase();
    if (name.includes("test-failed") && ct.startsWith("image/")) {
        return "screenshot captured at the moment Playwright reported failure";
    }
    if (ct.startsWith("image/")) return "screenshot";
    if (ct.startsWith("video/")) return "full session recording";
    if (name.includes("trace") || ct.includes("zip")) {
        return "Playwright trace (open with `npx playwright show-trace`)";
    }
    return "";
}

/**
 * Build the prompt sent to the model. Extracted from {@link streamInterpretation}
 * so it can be unit-tested with golden-text snapshots — the most common
 * regression here is "we forgot to forward field X", and a string
 * comparison surfaces that immediately without needing a live model.
 */
export function buildInterpretationPrompt(context: InterpretationContext): string {
    const { testResults, testCode, testFilePath, sourceCode, domContext, rawOutput } = context;

    const failedTests = testResults.filter((t) => t.status === "failed");
    const passedTests = testResults.filter((t) => t.status === "passed");
    const skippedTests = testResults.filter((t) => t.status === "skipped");

    const lines: string[] = [];

    lines.push(
        "You are analyzing Playwright E2E test results for a developer.",
        "",
        "A failure means the contract between the test and the application was broken.",
        "The break can come from EITHER side — the test, the application, the page state,",
        "or the environment. Examine the evidence first, then decide where the fault lies.",
        "Do not assume either side is wrong by default. Treat the test, the application,",
        "and the runtime environment as equally plausible suspects until the evidence",
        "narrows it.",
        "",
        "Ground every claim in the evidence below — quote the exact `Call log:` line,",
        "error message, snippet, DOM element, or attachment name you used to reach each",
        "conclusion. Do not invent causes that aren't supported by the supplied evidence.",
        "If the evidence is genuinely insufficient to pick a side, say so plainly and list",
        'the next concrete signal (e.g. "open trace.zip", "check server logs") rather than',
        "guessing.",
        "",
        `Run summary: ${testResults.length} total, ${passedTests.length} passed, ${failedTests.length} failed${
            skippedTests.length > 0 ? `, ${skippedTests.length} skipped` : ""
        }.`,
        "",
    );

    // Test code, pinned to a path so the model can flag mismatch.
    lines.push(`# Test code${testFilePath ? ` (\`${testFilePath}\`)` : ""}`);
    lines.push("```typescript");
    lines.push(truncateHead(testCode, TEST_CODE_BUDGET_CHARS));
    lines.push("```");
    lines.push("");

    if (sourceCode) {
        lines.push("# Source under test");
        lines.push("```typescript");
        lines.push(truncateHead(sourceCode, SOURCE_CODE_BUDGET_CHARS));
        lines.push("```");
        lines.push("");
    }

    if (domContext) {
        lines.push(`# DOM context (${domContext.url} — "${domContext.title}")`);
        lines.push("Interactive elements:");
        for (const el of domContext.interactiveElements.slice(0, 15)) {
            const label = el.name || el.text || "unnamed";
            const sel = el.suggestedSelectors[0] ?? "no selector";
            lines.push(`- ${el.role || el.tagName}: "${label}" → ${sel}`);
        }
        lines.push("Form fields:");
        for (const f of domContext.formFields.slice(0, 10)) {
            lines.push(`- ${f.name} (${f.type}): ${f.suggestedSelector}`);
        }
        lines.push("");
    }

    if (failedTests.length > 0) {
        lines.push("# Failures (with evidence)");
        for (const test of failedTests) {
            lines.push(`## ${test.suite} > ${test.name}`);
            if (test.error?.message) {
                const msg = truncateTail(stripAnsi(test.error.message), ERROR_MESSAGE_BUDGET_CHARS);
                lines.push("Error:");
                lines.push("```");
                lines.push(msg);
                lines.push("```");
            }
            if (test.error?.snippet) {
                lines.push("Code at failure:");
                lines.push("```");
                lines.push(stripAnsi(test.error.snippet));
                lines.push("```");
            }
            if (test.error?.location) {
                const loc = test.error.location;
                const file = loc.file.split("/").pop() ?? loc.file;
                lines.push(`Location: ${file}:${loc.line}:${loc.column}`);
            }
            if (test.attachments && test.attachments.length > 0) {
                lines.push("Attachments captured at failure time:");
                for (const att of test.attachments.slice(0, MAX_ATTACHMENTS_PER_TEST)) {
                    lines.push(describeAttachment(att));
                }
            }
            lines.push("");
        }
    }

    if (rawOutput && rawOutput.trim().length > 0) {
        lines.push(
            "# Raw run output (tail)",
            "Use this for Playwright's `Call log:`, console messages from the page, and timing context.",
            "",
            "```",
            truncateTail(stripAnsi(rawOutput), RAW_OUTPUT_BUDGET_CHARS),
            "```",
            "",
        );
    }

    lines.push("---");
    lines.push("Output (skip empty sections, use markdown):");
    lines.push("");
    lines.push("**1. Summary** — overall health in 1-2 lines.");
    lines.push("");
    lines.push("**2. Failures** — for each failed test:");
    lines.push(
        "- What happened: cite the specific `Call log:` line, error message, snippet, or DOM observation that describes the failure (in concrete terms — not the test's intent).",
    );
    lines.push("- Where the fault most likely lies — pick ONE and justify with evidence:");
    lines.push(
        "  - **Application** — the app's behaviour, response, markup, or state diverges from what the test reasonably asserts (regression, broken endpoint, missing element the page should render, server error, wrong content).",
    );
    lines.push(
        "  - **Test** — the test makes a flawed assumption (brittle selector for an element that DOES exist, race condition, missing wait, wrong assertion, hard-coded data).",
    );
    lines.push(
        "  - **Environment / data** — fixtures, auth, network, seed data, feature flags, or the run-host (not the test or app code itself).",
    );
    lines.push(
        "  - **Context-mismatch** — the supplied test code does not match what Playwright actually executed (see Constraints below).",
    );
    lines.push(
        "  - **Inconclusive** — evidence is genuinely insufficient; name the missing signal.",
    );
    lines.push(
        "- Sub-category if useful: selector drift, timing/race, missing data, server 5xx, auth gap, accessibility regression, etc.",
    );
    lines.push(
        "- Suggested next step: a fix on the side you attributed to (corrected test code, suspected source-file/handler if app, fixture or env tweak if data) — or, if Inconclusive, the next signal to gather.",
    );
    lines.push(
        "- Reference any screenshot/trace/video by filename if it would confirm or refute the diagnosis.",
    );
    lines.push("");
    if (failedTests.length === 0) {
        lines.push("**3. What's working well** — short, evidence-grounded.");
    } else {
        lines.push(
            "**3. Test quality observations** — OPTIONAL. Only include when the supplied test code contains a concrete weakness visible in the evidence (e.g. a CSS-selector chain Playwright is waiting on, missing await, no assertion after a navigation). Skip this section entirely if you have nothing specific to flag — generic 'add more assertions' advice is noise.",
        );
    }
    lines.push("");
    lines.push("Constraints:");
    lines.push(
        "- Context-mismatch test: if the supplied test code does NOT contain the locator(s) Playwright is waiting for in the Call log, attribute the failure to **Context-mismatch** and recommend re-running analysis after selecting the correct test file. Do not pick a different fault side.",
    );
    lines.push(
        "- When the error is a locator timeout, quote the exact selector verbatim from the Call log.",
    );
    lines.push(
        "- Prefer evidence from the Call log, error message, and DOM context over guesswork from the test name. The test name describes intent; the other signals describe what actually happened.",
    );
    lines.push(
        "- Do not default to 'fix the test'. If the page's current DOM context shows the asserted element is genuinely missing, broken, or in an unexpected state, attribute the failure to the **Application** and say so.",
    );

    return lines.join("\n");
}

/**
 * Stream the interpretation chunk-by-chunk. Module-private — the only
 * consumer is {@link getQuickInterpretation} below, which collects the
 * stream into a single string for the tRPC mutation. If the dashboard
 * adopts SSE streaming for AI insights in the future, re-export this
 * generator and adapt the router to forward chunks.
 */
async function* streamInterpretation(
    context: InterpretationContext,
    config: InterpretationConfig,
): AsyncGenerator<string, void, unknown> {
    if (!config.apiKey) {
        yield "Error: API key not configured for test interpretation.";
        return;
    }

    const openrouter = createOpenRouter({ apiKey: config.apiKey });
    const prompt = buildInterpretationPrompt(context);

    try {
        const result = await streamText({
            model: openrouter.chat(config.model || "anthropic/claude-sonnet-4.5"),
            prompt,
            temperature: 0.3,
            maxOutputTokens: 4096,
        });

        for await (const chunk of result.textStream) {
            yield chunk;
        }
    } catch (error) {
        yield `Error interpreting test results: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Get the full interpretation as a single string. The router uses this
 * for the `interpretTestResults` tRPC mutation; the streaming form is
 * collected behind the scenes.
 */
export async function getQuickInterpretation(
    context: InterpretationContext,
    config: InterpretationConfig,
): Promise<string> {
    let result = "";
    for await (const chunk of streamInterpretation(context, config)) {
        result += chunk;
    }
    return result;
}
