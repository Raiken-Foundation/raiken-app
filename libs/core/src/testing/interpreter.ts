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

import { generateText, streamText } from "ai";
import { buildAISdkModel, modelSupportsVision } from "../agent/ai-providers";
import type { DOMContext } from "../browser/dom-capture";
import type { AIProviderId } from "../config/schema";
import { cleanGeneratedTestCode } from "../utils";
import { applyEditBlocks, parseEditBlocks, stripEditMarkers } from "./edit-blocks";
import { validateTestCode } from "./test-code-validation";

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
    /**
     * Formatted snapshots of relevant discovered pages (from the site
     * knowledge DB). Gives headless callers — the CLI has no live browser —
     * the same "what the page actually contains" evidence the dashboard's
     * agent loop gets from live captures.
     */
    pageSummaries?: string[];
    projectPath: string;
}

export interface InterpretationConfig {
    apiKey: string;
    model?: string;
    /**
     * The configured provider. Native providers (Anthropic, Google) use their
     * own SDK; everything else routes through the OpenAI-compatible client at
     * `baseURL`. Defaults to OpenRouter routing when omitted.
     */
    provider?: AIProviderId;
    /**
     * Base URL of the configured provider's OpenAI-compatible endpoint.
     * When omitted, defaults to OpenRouter. Passing this lets AI analysis
     * use whatever provider the user configured (OpenAI, Anthropic, Ollama…).
     */
    baseURL?: string;
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
    const {
        testResults,
        testCode,
        testFilePath,
        sourceCode,
        domContext,
        pageSummaries,
        rawOutput,
    } = context;

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

    if (pageSummaries && pageSummaries.length > 0) {
        lines.push("# Captured pages (discovery knowledge)");
        lines.push(
            "Snapshots of the discovered pages most relevant to this spec. Treat these as",
            "the ground truth for which elements exist; prefer their selectors over guesses.",
        );
        for (const summary of pageSummaries.slice(0, 4)) {
            lines.push("", summary);
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
    // A key is required for hosted providers, but local ones (e.g. Ollama)
    // work without one as long as a base URL is set.
    if (!config.apiKey && !config.baseURL) {
        yield "Error: API key not configured for test interpretation.";
        return;
    }

    const model = buildAISdkModel({
        provider: config.provider ?? "openrouter",
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model || "anthropic/claude-sonnet-4.5",
    });
    const prompt = buildInterpretationPrompt(context);

    try {
        const result = await streamText({
            model,
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

// ---------------------------------------------------------------------------
// Test repair
//
// The interpretation above tells the developer WHAT went wrong; this closes
// the loop by producing the corrected spec. It reuses the exact same evidence
// (test code, failures, raw Call log, DOM, and — critically — the prior AI
// analysis if the user already ran one) so the fix is grounded in the same
// diagnosis the developer just read, rather than re-reasoning from scratch.
// ---------------------------------------------------------------------------

/**
 * A raw image (typically the Playwright failure screenshot) forwarded to a
 * vision-capable model so the repair can SEE the page state at the moment of
 * failure, not just read text about it. Bytes are read server-side from the
 * on-disk attachment path (see the `repairTestResults` router procedure).
 */
export interface RepairImage {
    /** Attachment name, e.g. "test-failed-1.png". */
    name: string;
    /** Raw image bytes. */
    data: Uint8Array;
    /** MIME type, e.g. "image/png". */
    mediaType: string;
}

export interface RepairContext extends InterpretationContext {
    /**
     * The prior AI analysis text (from {@link getQuickInterpretation}), if the
     * user already ran "Analyze with AI". Passing it lets the repair honour the
     * diagnosis the developer just read instead of re-deriving a (possibly
     * different) root cause.
     */
    interpretation?: string;
    /**
     * Failure screenshots (bytes) to send to a vision-capable model. When
     * present the repair call attaches them as image parts so the model can
     * ground selector/assertion fixes in what the page actually rendered.
     * Best-effort: if the configured model can't accept images the repair
     * transparently falls back to a text-only prompt.
     */
    images?: RepairImage[];
}

export interface RepairResult {
    /** Corrected, fence-stripped test file, or null if the model returned nothing usable. */
    fixedCode: string | null;
    /** The original file the fix was computed against — lets the UI show a diff. */
    originalCode?: string;
    /**
     * How the fix was produced:
     * - "edits": the model returned SEARCH/REPLACE blocks we applied in place.
     * - "full": the model returned (or we fell back to) a complete file rewrite.
     */
    mode?: "edits" | "full";
    /** Number of SEARCH/REPLACE blocks applied (0 for a full rewrite). */
    editCount?: number;
    /**
     * True when the model asked for section edits but one or more blocks could
     * not be matched, so we fell back to a full-file rewrite. Signals the UI to
     * warn the developer to review carefully.
     */
    matchFailed?: boolean;
    /** Populated when the fix could not be produced (missing key, model error, unparseable output). */
    error?: string;
}

const INTERPRETATION_BUDGET_CHARS = 4000;

export function buildRepairPrompt(
    context: RepairContext,
    mode: "edits" | "full" = "edits",
): string {
    const {
        testResults,
        testCode,
        testFilePath,
        sourceCode,
        domContext,
        pageSummaries,
        rawOutput,
        interpretation,
        images,
    } = context;

    const failedTests = testResults.filter((t) => t.status === "failed");

    const lines: string[] = [];

    lines.push(
        "You are fixing a failing Playwright E2E test so that it passes for the RIGHT reason.",
        "",
        "Return a CONCRETE, RUNNABLE fix — corrected test code that will actually execute and",
        "pass. Do NOT return a skeleton of `// TODO:` placeholders, and do NOT replace real",
        "steps, waits, or assertions with TODO comments. The developer wants working code they",
        "can run immediately, not a checklist of things to do later.",
        "",
        "Ground every change in the evidence below. Use only the selectors, URLs, routes,",
        "and behaviour that the test, the errors, the Call log, the DOM context, and the",
        "failure screenshot (when present) actually show. Do NOT invent selectors, routes,",
        "credentials, or app behaviour, and do NOT assume how this particular app is built —",
        "each project is unique, so fix what the evidence supports and nothing more.",
        "",
        "Most failures are test-side: a stale or brittle selector, a missing wait, a wrong URL,",
        "or an assertion that no longer matches what the page renders. Fix these directly using",
        "the real selectors/URLs/state visible in the evidence and screenshot.",
        "",
        "Only when the evidence clearly shows a genuine APPLICATION regression (the app itself",
        "is broken and the test correctly caught it) should you keep the meaningful assertion",
        "intact instead of weakening it. In that single case you MAY add ONE short `// TODO:`",
        "line naming the suspected app-side issue — but never scatter multiple TODOs, never stub",
        "out logic with TODOs, and never delete a real assertion just to make the test pass.",
        "",
        "Preserve the original intent of the test. Change the minimum needed to make it",
        "correct — do not rewrite unrelated parts or rename things gratuitously.",
        "",
    );

    lines.push(`# Failing test file${testFilePath ? ` (\`${testFilePath}\`)` : ""}`);
    lines.push("```typescript");
    lines.push(truncateHead(testCode, TEST_CODE_BUDGET_CHARS));
    lines.push("```");
    lines.push("");

    if (interpretation && interpretation.trim().length > 0) {
        lines.push(
            "# Prior AI analysis (the diagnosis the developer just read — honour it)",
            truncateTail(interpretation, INTERPRETATION_BUDGET_CHARS),
            "",
        );
    }

    if (failedTests.length > 0) {
        lines.push("# Failures (with evidence)");
        for (const test of failedTests) {
            lines.push(`## ${test.suite} > ${test.name}`);
            if (test.error?.message) {
                lines.push("Error:");
                lines.push("```");
                lines.push(truncateTail(stripAnsi(test.error.message), ERROR_MESSAGE_BUDGET_CHARS));
                lines.push("```");
            }
            if (test.error?.snippet) {
                lines.push("Code at failure:");
                lines.push("```");
                lines.push(stripAnsi(test.error.snippet));
                lines.push("```");
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

    if (images && images.length > 0) {
        lines.push(
            "# Failure screenshot",
            "A screenshot of the page at the moment Playwright reported failure is attached to",
            "this message. Treat it as ground truth for what the user actually saw — the visible",
            "text, which elements are present or missing, any error banners, and the real page",
            "state. Prefer it over assumptions when choosing selectors or deciding whether the",
            "test or the application is at fault.",
            "",
        );
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

    if (pageSummaries && pageSummaries.length > 0) {
        lines.push("# Captured pages (discovery knowledge)");
        lines.push(
            "Snapshots of the discovered pages most relevant to this spec. Treat these as",
            "the ground truth for which elements exist; prefer their selectors over guesses.",
        );
        for (const summary of pageSummaries.slice(0, 4)) {
            lines.push("", summary);
        }
        lines.push("");
    }

    if (sourceCode) {
        lines.push("# Source under test (reference only)");
        lines.push("```typescript");
        lines.push(truncateHead(sourceCode, SOURCE_CODE_BUDGET_CHARS));
        lines.push("```");
        lines.push("");
    }

    if (rawOutput && rawOutput.trim().length > 0) {
        lines.push(
            "# Raw run output (tail — Call log & console)",
            "```",
            truncateTail(stripAnsi(rawOutput), RAW_OUTPUT_BUDGET_CHARS),
            "```",
            "",
        );
    }

    lines.push("---");
    lines.push("Rules for the corrected file:");
    lines.push(
        "- No fixed sleeps (`waitForTimeout`, `page.waitForTimeout`, arbitrary `sleep`). Use web-first assertions with timeouts, `waitForURL`, or `waitForResponse` to wait on real signals.",
    );
    lines.push(
        "- Selector priority: `getByRole` > `getByLabel` > `getByPlaceholder` > `getByTestId` > `getByText`. Only fall back to CSS when nothing else fits the evidence.",
    );
    lines.push("- Keep imports and the overall structure of the original file.");
    lines.push(
        "- Output only runnable code — no explanatory prose or changelog inside the file. At most ONE `// TODO:` line is allowed, and only for a confirmed application-side regression (see above).",
    );
    lines.push("");

    if (mode === "edits") {
        lines.push(
            "Return your fix as one or more SEARCH/REPLACE edit blocks that change only",
            "the sections that need to change. This keeps the fix minimal and reviewable.",
            "",
            "Each block MUST use exactly this format:",
            "",
            "<<<<<<< SEARCH",
            "<a short, exact, contiguous snippet copied verbatim from the file above>",
            "=======",
            "<the replacement for that snippet>",
            ">>>>>>> REPLACE",
            "",
            "Rules for edit blocks:",
            "- The SEARCH text must match the current file EXACTLY (same characters and",
            "  indentation). Copy it directly from the file above — do not paraphrase.",
            "- Keep each SEARCH snippet small (just the lines you are changing plus a line",
            "  or two of context if needed to make it unique). Use multiple blocks rather",
            "  than one giant block.",
            "- To delete code, leave the REPLACE section empty.",
            "- Output ONLY the edit blocks. No markdown fences, no prose before or after.",
            "- If the change is so extensive that section edits don't make sense, instead",
            "  output the COMPLETE corrected file (no fences, no prose) and no edit blocks.",
        );
    } else {
        lines.push(
            "Output ONLY the complete corrected test file. No markdown fences, no commentary before or after — just the file contents.",
        );
    }

    return lines.join("\n");
}

/**
 * Produce a corrected version of a failing test. Returns cleaned code ready to
 * drop into the editor for the developer to review, run, and save. Mirrors the
 * provider handling of {@link streamInterpretation} so the fix uses whatever
 * AI provider the user configured (OpenAI, Anthropic, OpenRouter, Ollama…).
 */
export async function getTestRepair(
    context: RepairContext,
    config: InterpretationConfig,
): Promise<RepairResult> {
    if (!config.apiKey && !config.baseURL) {
        return { fixedCode: null, error: "API key not configured for test repair." };
    }

    const model = buildAISdkModel({
        provider: config.provider ?? "openrouter",
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model || "anthropic/claude-sonnet-4.5",
    });

    // When failure screenshots are available AND the model is vision-capable,
    // send them as image parts so the fix is grounded in what the page actually
    // rendered. A model the catalog knows to be text-only (e.g. deepseek-chat)
    // is never sent images — the request would be rejected and the provider's
    // raw deserialize error would leak into the CLI before the text-only retry.
    // For models with unknown capabilities this stays best-effort: on any
    // error we transparently retry the same call text-only.
    const hasImages =
        !!context.images &&
        context.images.length > 0 &&
        modelSupportsVision(
            config.provider ?? "openrouter",
            config.model || "anthropic/claude-sonnet-4.5",
        );
    const generate = async (mode: "edits" | "full") => {
        const prompt = buildRepairPrompt(context, mode);
        if (hasImages) {
            try {
                return await generateText({
                    model,
                    temperature: 0.2,
                    maxOutputTokens: 8192,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                ...(context.images ?? []).map((img) => ({
                                    type: "image" as const,
                                    image: img.data,
                                    mediaType: img.mediaType,
                                })),
                            ],
                        },
                    ],
                });
            } catch (err) {
                console.warn(
                    "Test repair with vision failed; retrying text-only:",
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        return await generateText({
            model,
            prompt,
            temperature: 0.2,
            maxOutputTokens: 8192,
        });
    };

    /**
     * Same gate generation and agent repair use. Without it a truncated stream
     * or a prose reply reaches the editor as a "fix" the developer can save.
     */
    const rejectIfInvalid = (code: string): RepairResult | null => {
        const validation = validateTestCode(code);
        if (validation.ok) return null;
        return { fixedCode: null, error: `The model's fix ${validation.reason}.` };
    };

    const fullRewrite = async (matchFailed: boolean): Promise<RepairResult> => {
        const { text } = await generate("full");
        const cleaned = cleanGeneratedTestCode(stripEditMarkers(text));
        const invalid = rejectIfInvalid(cleaned);
        if (invalid) return invalid;
        return {
            fixedCode: cleaned,
            originalCode: context.testCode,
            mode: "full",
            editCount: 0,
            matchFailed,
        };
    };

    try {
        // First pass: ask for minimal SEARCH/REPLACE edits so the model changes
        // only the sections that are wrong instead of rewriting the whole file.
        const { text } = await generate("edits");
        const blocks = parseEditBlocks(text);

        // No well-formed blocks → treat as a full file, but strip any stray
        // markers left by a malformed/half-written block first.
        if (blocks.length === 0) {
            const cleaned = cleanGeneratedTestCode(stripEditMarkers(text));
            const invalid = rejectIfInvalid(cleaned);
            if (invalid) return invalid;
            return {
                fixedCode: cleaned,
                originalCode: context.testCode,
                mode: "full",
                editCount: 0,
            };
        }

        const applied = applyEditBlocks(context.testCode, blocks);

        // If every block matched, we have a clean, minimal, in-place edit.
        if (applied.failedBlocks.length === 0 && applied.appliedCount > 0) {
            const edited = ensureTrailingNewline(applied.content);
            // Edits can match textually and still leave the file unparseable
            // (e.g. a replacement that drops a closing brace).
            const invalid = rejectIfInvalid(edited);
            if (invalid) return await fullRewrite(true);
            return {
                fixedCode: edited,
                originalCode: context.testCode,
                mode: "edits",
                editCount: applied.appliedCount,
            };
        }

        // Some (or all) blocks failed to match the file. Rather than apply a
        // partial, possibly-broken edit, fall back to a full-file rewrite so the
        // developer always gets a coherent proposal to review.
        return await fullRewrite(true);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { fixedCode: null, error: `Repair failed: ${msg}` };
    }
}

function ensureTrailingNewline(content: string): string {
    return content.endsWith("\n") ? content : `${content}\n`;
}
