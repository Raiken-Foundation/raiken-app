import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphStateType } from "../state";
import type { AgentClassifierResult } from "../../prompts";
import type { AgentNodeDeps } from "./types";

const classifierSchema = z.object({
    intent: z.enum(["explore", "generateTests", "explain"]).describe(
        "The user's intent: 'explore' to navigate/discover a site, 'generateTests' to create E2E tests, 'explain' to answer questions about code or project"
    ),
    goal: z.string().nullable().describe("A short summary of what the user wants to achieve"),
    targetFeature: z.string().nullable().describe("The specific feature or component the user is asking about"),
    targetUrl: z.string().nullable().describe("A URL mentioned or implied by the user, if any"),
    nextTool: z
        .enum(["domCapture", "codeSearch", "testGen", "explain", "discoveryRead", "none"])
        .nullable()
        .describe(
            "The best tool to use next: 'domCapture' for browser/UI work, 'codeSearch' for finding code, 'testGen' for test generation, 'explain' for explanations, 'discoveryRead' for reading site discovery data, 'none' for no specific tool"
        ),
    missingContext: z.array(z.string()).describe("List of information still needed to fulfill the request"),
    shouldRunTests: z.boolean().describe(
        "True if the user explicitly wants to run/execute/verify the generated tests, not just generate them. Only true when the user says things like 'run the tests', 'execute them', 'verify they pass', 'make sure they work', etc."
    ),
    isContinuation: z.boolean().describe(
        "True ONLY if the user's message is a direct reply to a previous pause/interruption (e.g. providing login credentials, confirming 'login completed', saying 'done' or 'continue'). False if the user is giving a new command, asking a new question, or starting a different task."
    ),
});

type ClassifierOutput = z.infer<typeof classifierSchema>;

export const createClassifyGoalNode =
    (deps: AgentNodeDeps) => async (state: GraphStateType) => {
        const prompt = deps.buildAgentClassifierPrompt({
            userPrompt: state.userPrompt,
            conversationHistory: state.conversationHistory,
            storedGoal: deps.getGoalState?.(),
            pauseReason: state.pauseReason || null,
        });

        try {
            const structuredModel = deps.model.withStructuredOutput(classifierSchema, {
                name: "classify_user_intent",
            });

            let result: ClassifierOutput;
            try {
                const response = await structuredModel.invoke([
                    new SystemMessage(prompt),
                    new HumanMessage(state.userPrompt),
                ]);
                result = response;
            } catch (structuredError) {
                // Structured output failed (model doesn't support it, or schema mismatch).
                // Fall back to raw JSON parsing.
                result = await fallbackClassify(deps, prompt, state.userPrompt);
            }

            deps.setActiveIntent?.(result.intent);
            deps.setGoalState?.({
                goal: result.goal,
                targetFeature: result.targetFeature,
                targetUrl: result.targetUrl,
                missingContext: result.missingContext,
                nextTool: result.nextTool,
            });

            const stateUpdates: Record<string, unknown> = {
                intent: result.intent,
                activeGoal: result.goal,
                targetFeature: result.targetFeature,
                targetUrl: result.targetUrl,
                missingContext: result.missingContext,
                nextTool: result.nextTool,
                shouldRunTests: result.shouldRunTests,
                pauseReason: null,
            };

            if (state.pauseReason) {
                if (result.isContinuation) {
                    console.log(`▶️  LLM confirmed: continuing paused session (${state.pauseReason})`);
                    stateUpdates["pagesVisited"] = state.pendingPagesVisited || [];
                    stateUpdates["currentUrl"] = state.pendingCurrentUrl || null;
                } else {
                    console.log(`🧹 LLM confirmed: new command (discarding paused state from: ${state.pauseReason})`);
                }
                stateUpdates["pendingPagesVisited"] = [];
                stateUpdates["pendingCurrentUrl"] = null;
            }

            return stateUpdates;
        } catch (error) {
            console.warn("⚠️ Classifier failed:", error instanceof Error ? error.message : error);

            // On failure, discard stale state (safe default)
            return {
                shouldPause: true,
                awaitUserMessage:
                    "I could not classify your request. Please restate the goal in one sentence (what you want and what to focus on).",
                pauseReason: null,
                pendingPagesVisited: [],
                pendingCurrentUrl: null,
            };
        }
    };

/**
 * Fallback: invoke the model raw and parse JSON from its text output.
 * Used when withStructuredOutput is not supported by the provider.
 */
async function fallbackClassify(
    deps: AgentNodeDeps,
    systemPrompt: string,
    userPrompt: string
): Promise<ClassifierOutput> {
    const strictPrompt = `${systemPrompt}\n\nReturn JSON only, no fences:\n${JSON.stringify(classifierSchema.shape)}`;

    const response = await deps.model.invoke([
        new SystemMessage(strictPrompt),
        new HumanMessage(userPrompt),
    ]);

    const content = Array.isArray(response.content)
        ? response.content
              .map((part) => (typeof part === "string" ? part : part?.text || ""))
              .join("")
        : response.content;

    if (!content || typeof content !== "string") {
        throw new Error("Classifier returned empty output.");
    }

    let cleaned = content.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch?.[1]) {
        cleaned = fenceMatch[1].trim();
    }
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }

    const parsed = JSON.parse(cleaned);
    return classifierSchema.parse({
        intent: parsed.intent,
        goal: parsed.goal ?? null,
        targetFeature: parsed.targetFeature ?? null,
        targetUrl: parsed.targetUrl ?? null,
        nextTool: parsed.nextTool ?? null,
        missingContext: Array.isArray(parsed.missingContext)
            ? parsed.missingContext.filter((item: unknown) => typeof item === "string")
            : [],
        shouldRunTests: parsed.shouldRunTests ?? false,
        isContinuation: parsed.isContinuation ?? false,
    });
}
