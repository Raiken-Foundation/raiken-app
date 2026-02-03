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
    const parsed = JSON.parse(raw);
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
    return classifierSchema.parse(normalized);
};

export const createClassifyGoalNode =
    (deps: AgentNodeDeps) => async (state: GraphStateType) => {
        const prompt = deps.buildAgentClassifierPrompt({
            userPrompt: state.userPrompt,
            conversationHistory: state.conversationHistory,
            storedGoal: deps.getGoalState?.(),
        });

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
            return {
                shouldPause: true,
                awaitUserMessage:
                    "I could not classify your request. Please restate the goal in one sentence (what you want and what to focus on).",
            };
        }
    };
