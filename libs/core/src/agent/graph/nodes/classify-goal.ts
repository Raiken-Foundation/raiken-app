import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphStateType } from "../state";
import { shouldRunTests } from "../utils";
import type { AgentClassifierResult } from "../../prompts";
import type { AgentNodeDeps } from "./types";

const classifierSchema = z.object({
    intent: z.enum(["explore", "generateTests", "explain"]),
    goal: z.string().nullable(),
    targetFeature: z.string().nullable(),
    targetUrl: z.string().nullable(),
    nextTool: z.enum(["domCapture", "codeSearch", "testGen", "explain", "none"]).nullable(),
    missingContext: z.array(z.string()),
});

const parseClassifierResult = (raw: string): AgentClassifierResult => {
    let cleaned = raw.trim();
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
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Classifier output is not an object.");
    }
    const normalized = {
        intent: parsed.intent,
        goal: parsed.goal ?? null,
        targetFeature: parsed.targetFeature ?? null,
        targetUrl: parsed.targetUrl ?? null,
        nextTool: parsed.nextTool ?? null,
        missingContext: Array.isArray(parsed.missingContext)
            ? parsed.missingContext.filter((item: unknown) => typeof item === "string")
            : [],
    };
    const result = classifierSchema.parse(normalized);
    return {
        intent: result.intent,
        goal: result.goal ?? null,
        targetFeature: result.targetFeature ?? null,
        targetUrl: result.targetUrl ?? null,
        nextTool: result.nextTool ?? null,
        missingContext: result.missingContext ?? [],
    };
};

export const createClassifyGoalNode =
    (deps: AgentNodeDeps) => async (state: GraphStateType) => {
        const prompt = deps.buildAgentClassifierPrompt({
            userPrompt: state.userPrompt,
            conversationHistory: state.conversationHistory,
            storedGoal: deps.getGoalState?.(),
        });

        let lastRawResponse: string | null = null;
        const classify = async (systemPrompt: string): Promise<AgentClassifierResult> => {
            const response = await deps.model.invoke([
                new SystemMessage(systemPrompt),
                new HumanMessage(state.userPrompt),
            ]);
            const content = Array.isArray(response.content)
                ? response.content
                      .map((part) => (typeof part === "string" ? part : part?.text || ""))
                      .join("")
                : response.content;
            if (!content || typeof content !== "string") {
                throw new Error("Classifier returned empty output.");
            }
            lastRawResponse = content;
            return parseClassifierResult(content);
        };

        try {
            let result: AgentClassifierResult;
            try {
                result = await classify(prompt);
            } catch {
                const strictPrompt = `${prompt}\n\nReminder: Output ONLY valid JSON. No code fences.`;
                result = await classify(strictPrompt);
            }

            deps.setActiveIntent?.(result.intent);
            deps.setGoalState?.({
                goal: result.goal,
                targetFeature: result.targetFeature,
                targetUrl: result.targetUrl,
                missingContext: result.missingContext,
                nextTool: result.nextTool,
            });

            return {
                intent: result.intent,
                activeGoal: result.goal,
                targetFeature: result.targetFeature,
                targetUrl: result.targetUrl,
                missingContext: result.missingContext,
                nextTool: result.nextTool,
                shouldRunTests: shouldRunTests(state.userPrompt),
            };
        } catch (error) {
            if (lastRawResponse) {
                const snippet = String(lastRawResponse).slice(0, 800);
                console.warn("⚠️ Classifier parse failed. Raw output snippet:", snippet);
            } else {
                console.warn("⚠️ Classifier parse failed with no output.");
            }
            console.warn("⚠️ Classifier error:", error instanceof Error ? error.message : error);
            return {
                shouldPause: true,
                awaitUserMessage:
                    "I could not classify your request. Please restate the goal in one sentence (what you want and what to focus on).",
            };
        }
    };
