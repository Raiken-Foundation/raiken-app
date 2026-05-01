import * as fsSync from "node:fs";
import * as path from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphStateType } from "../state";
import type { AgentNodeDeps } from "./types";
import type { TestRunResult } from "../../../testing/runner";

interface AutoCorrectConfig {
    autoCorrect: "suggest" | "apply" | "off";
    maxRetries: number;
}

function loadAutoCorrectConfig(projectPath: string): AutoCorrectConfig {
    const defaults: AutoCorrectConfig = { autoCorrect: "suggest", maxRetries: 2 };
    try {
        const raw = fsSync.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8");
        const config = JSON.parse(raw) as {
            autonomy?: { autoCorrect?: string; maxRetries?: number };
        };
        if (config.autonomy?.autoCorrect === "apply" || config.autonomy?.autoCorrect === "off") {
            defaults.autoCorrect = config.autonomy.autoCorrect;
        }
        if (typeof config.autonomy?.maxRetries === "number" && config.autonomy.maxRetries >= 0) {
            defaults.maxRetries = config.autonomy.maxRetries;
        }
    } catch {
        // Config missing or invalid
    }
    return defaults;
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
    if (/^import\s/m.test(trimmed) || /\btest\s*\(/.test(trimmed) || /\btest\.describe\s*\(/.test(trimmed)) {
        return trimmed;
    }

    return null;
}

export function shouldRepair(state: GraphStateType, projectPath: string): boolean {
    if (!state.testRunResult) return false;
    const hasFailures = state.testRunResult.some((r) => r.status !== "passed");
    if (!hasFailures) return false;

    const config = loadAutoCorrectConfig(projectPath);
    if (config.autoCorrect === "off") return false;
    if (state.repairAttempts >= config.maxRetries) return false;

    return true;
}

export const createRepairNode =
    ({ callTool, gatherContext, projectPath, model }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const results = state.testRunResult;
        if (!results || results.every((r) => r.status === "passed")) {
            return {};
        }

        const config = loadAutoCorrectConfig(projectPath);
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

        const contextSnippets = context?.files
            ?.slice(0, 5)
            .map((f) => `--- ${f.path} ---\n${f.fullContext.slice(0, 1500)}`)
            .join("\n\n") || "";

        const systemPrompt = `Fix this failing Playwright test so it passes.

Test:
\`\`\`typescript
${testCode.slice(0, 4000)}
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
            const response = await model.invoke([
                new SystemMessage(systemPrompt),
                new HumanMessage("Fix this failing test."),
            ]);

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

        if (config.autoCorrect === "apply" && state.savedTestPath) {
            const saveResult = await callTool("saveFile", {
                filePath: state.savedTestPath,
                content: fixedCode,
                testName: path.basename(state.savedTestPath),
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
            };
        }

        return {
            testDraft: fixedCode,
            repairAttempts: attemptNum,
            shouldPause: true,
            awaitUserMessage: `Test repair suggestion (attempt ${attemptNum}):\n\nThe corrected test has been generated. Review the changes and approve to save.`,
        };
    };
