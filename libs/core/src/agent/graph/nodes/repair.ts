import * as fsSync from "node:fs";
import * as path from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { loadAutonomyConfig } from "../../../config";
import type { TestRunResult } from "../../../testing/runner";
import { LLM_REQUEST_TIMEOUT_MS } from "../../ai-providers";
import type { AutonomySettings } from "../../tools";
import type { GraphStateType } from "../state";
import type { AgentNodeDeps } from "./types";

/**
 * Resolve autonomy settings for a node. Prefers the settings threaded
 * through by `agent.ts` (which already merges `raiken.config.json` with any
 * session-scoped override, e.g. the REPL's `/mode`); falls back to reading
 * the config file directly so nodes still work in isolation (tests, or any
 * caller that didn't wire `deps.autonomy` through).
 */
export function resolveAutonomy(
    deps: Pick<AgentNodeDeps, "autonomy" | "projectPath">,
): AutonomySettings {
    return deps.autonomy ?? loadAutonomyConfig(deps.projectPath);
}

function formatFailures(results: TestRunResult[]): string {
    const failures = results.filter((r) => r.status !== "passed");
    if (failures.length === 0) return "All tests passed.";

    return failures
        .map((f, i) => {
            const lines = [`Failure ${i + 1}: ${f.testName} (${f.status})`];
            if (f.error?.message) lines.push(`  Error: ${f.error.message}`);
            if (f.error?.selector) lines.push(`  Failing selector: ${f.error.selector}`);
            if (f.error?.stack) lines.push(`  Stack (truncated): ${f.error.stack.slice(0, 500)}`);
            return lines.join("\n");
        })
        .join("\n\n");
}

function extractCodeFromResponse(raw: string): string | null {
    if (!raw || raw.trim().length === 0) return null;

    const fenceMatch = raw.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)```/);
    if (fenceMatch?.[1]?.trim()) {
        return fenceMatch[1].trim();
    }

    // If the response looks like raw TypeScript (has import statements or test blocks)
    const trimmed = raw.trim();
    if (
        /^import\s/m.test(trimmed) ||
        /\btest\s*\(/.test(trimmed) ||
        /\btest\.describe\s*\(/.test(trimmed)
    ) {
        return trimmed;
    }

    return null;
}

export function shouldRepair(state: GraphStateType, autonomy: AutonomySettings): boolean {
    if (!state.testRunResult) return false;
    const hasFailures = state.testRunResult.some((r) => r.status !== "passed");
    if (!hasFailures) return false;

    if (autonomy.autoCorrect === "off") return false;
    if (state.repairAttempts >= autonomy.maxRetries) return false;

    return true;
}

export const createRepairNode = (deps: AgentNodeDeps) => async (state: GraphStateType) => {
    const { callTool, gatherContext, projectPath, model } = deps;
    const results = state.testRunResult;
    if (!results || results.every((r) => r.status === "passed")) {
        return {};
    }

    const attemptNum = state.repairAttempts + 1;

    let testCode = "";
    if (state.savedTestPath) {
        try {
            const absPath = path.isAbsolute(state.savedTestPath)
                ? state.savedTestPath
                : path.join(projectPath, state.savedTestPath);
            testCode = fsSync.readFileSync(absPath, "utf-8");
        } catch {
            testCode = state.testDraft || "";
        }
    } else {
        testCode = state.testDraft || "";
    }

    if (!testCode) {
        return {
            repairAttempts: attemptNum,
            summary: `Repair attempt ${attemptNum}: No test code available to repair.`,
        };
    }

    let context = state.context;
    try {
        const contextPrompt = `repair failing test: ${results[0]?.testName || "unknown"}`;
        context = context || (await gatherContext(contextPrompt, projectPath));
    } catch {
        // Context gathering failed; proceed with what we have
    }

    const contextSnippets =
        context?.files
            ?.slice(0, 5)
            .map((f) => `--- ${f.path} ---\n${f.fullContext.slice(0, 1500)}`)
            .join("\n\n") || "";

    // The model needs the WHOLE test file to fix it correctly — a hard
    // 4000-char slice silently cut off anything past ~100 lines, so on any
    // real-sized spec the model was repairing blind past that point (and
    // could return a truncated/invented rewrite of the tail, corrupting the
    // file on save). Cap far higher and only truncate pathologically large
    // files, flagging it clearly rather than silently hiding the cut.
    const MAX_TEST_CODE_CHARS = 20_000;
    const testCodeForPrompt =
        testCode.length > MAX_TEST_CODE_CHARS
            ? `${testCode.slice(0, MAX_TEST_CODE_CHARS)}\n// ... [TRUNCATED: ${
                  testCode.length - MAX_TEST_CODE_CHARS
              } more characters omitted — file too large to repair reliably in one pass]`
            : testCode;

    const systemPrompt = `Fix this failing Playwright test so it passes.

Test:
\`\`\`typescript
${testCodeForPrompt}
\`\`\`

Failures:
${formatFailures(results)}
${state.domSummary ? `\nDOM:\n${state.domSummary.slice(0, 2000)}` : ""}
${contextSnippets ? `\nSource:\n${contextSnippets}` : ""}

Rules:
- If selectors are wrong, replace them using the DOM. Prefer getByRole > getByTestId > getByText over raw CSS.
- If logic is wrong, fix assertions/flow.
- Output ONLY the corrected test file in a single \`\`\`typescript fence. No prose outside the fence.`;

    let fixedCode: string | null = null;

    try {
        const response = await model.invoke(
            [new SystemMessage(systemPrompt), new HumanMessage("Fix this failing test.")],
            { timeout: LLM_REQUEST_TIMEOUT_MS },
        );

        const rawContent = Array.isArray(response.content)
            ? response.content
                  .map((part) => (typeof part === "string" ? part : part?.text || ""))
                  .join("")
            : response.content;

        fixedCode = extractCodeFromResponse(rawContent);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isRateLimit = /rate.?limit|429|too many requests/i.test(msg);
        return {
            repairAttempts: attemptNum,
            summary: isRateLimit
                ? `Repair attempt ${attemptNum}: Rate limited by AI provider. Try again shortly.`
                : `Repair attempt ${attemptNum}: AI call failed: ${msg.slice(0, 200)}`,
        };
    }

    if (!fixedCode) {
        return {
            repairAttempts: attemptNum,
            summary: `Repair attempt ${attemptNum}: AI returned no usable code. The response could not be parsed as a valid test file.`,
        };
    }

    // No-progress guard: if the "fix" is (modulo whitespace) identical to
    // what we just ran, or to the previous attempt's fix, the AI isn't
    // converging — it's returning the same code back. Continuing would
    // just re-run the exact same failing test and burn through
    // `maxRetries` for nothing. Stop now with a clear, actionable message
    // instead of silently exhausting attempts (or, in "apply" mode,
    // repeatedly "fixing" a file with no actual change). Compared with
    // `.trim()` because `extractCodeFromResponse` trims the AI's fence
    // content while `testCode` (read from disk or the draft) commonly
    // keeps a trailing newline — an untrimmed comparison would almost
    // never fire for a genuinely unchanged response.
    const isUnchangedFrom = (other: string | null) =>
        other !== null && fixedCode !== null && fixedCode.trim() === other.trim();
    if (isUnchangedFrom(testCode) || isUnchangedFrom(state.lastRepairedCode)) {
        return {
            repairAttempts: attemptNum,
            shouldPause: true,
            lastRepairedCode: fixedCode,
            summary: `Repair attempt ${attemptNum}: AI returned the test unchanged from ${
                isUnchangedFrom(testCode) ? "the current file" : "its previous attempt"
            } — it isn't converging on a fix. Stopping automatic repair.`,
            awaitUserMessage: `Automatic repair couldn't find a working fix after ${attemptNum} attempt(s) — the AI kept returning the same code. Please review the failure and edit the test manually.`,
        };
    }

    // Both "suggest" and "apply" retry autonomously up to `maxRetries` —
    // pausing after every single attempt (the old "suggest" behavior)
    // defeated the point of automatic repair, and requiring a fresh
    // approval for a write here is redundant: the file was already
    // approved once to reach the repair loop at all, so `autoCorrect`
    // (not `autoSaveTests`) is the authorizing signal for THIS write.
    // `_repairVerification` tells the tool to use that gate instead.
    // The two modes now differ only in what happens once the loop ends:
    // "apply" fully trusts the loop and just reports the outcome via the
    // normal summary either way; "suggest" gets one explicit pause, but
    // only when automatic repair is exhausted and still failing (see
    // `createHitlRunNode`) — never on the happy path.
    if (state.savedTestPath) {
        const saveResult = await callTool("saveFile", {
            filePath: state.savedTestPath,
            content: fixedCode,
            testName: path.basename(state.savedTestPath),
            _repairVerification: true,
        });
        if (!saveResult.success) {
            return {
                summary: `Repair attempt ${attemptNum} failed to save: ${saveResult.message}`,
                repairAttempts: attemptNum,
            };
        }
        return {
            testDraft: fixedCode,
            repairAttempts: attemptNum,
            testRunResult: null,
            lastRepairedCode: fixedCode,
        };
    }

    // No file to repair in place (e.g. the draft was never saved) —
    // nothing to verify against, so fall back to holding the candidate
    // for manual review.
    return {
        testDraft: fixedCode,
        repairAttempts: attemptNum,
        shouldPause: true,
        lastRepairedCode: fixedCode,
        awaitUserMessage: `Test repair suggestion (attempt ${attemptNum}):\n\nThe corrected test has been generated. Review the changes and approve to save.`,
    };
};
