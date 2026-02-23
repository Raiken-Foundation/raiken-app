import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphState, type GraphStateType } from "./state";
import type { AgentNodeDeps } from "./nodes/types";
import { createClassifyGoalNode } from "./nodes/classify-goal";
import { createNavigateNode, createExploreNode } from "./nodes/navigation";
import {
    createAwaitUserNode,
    createCaptureAfterResolveNode,
    createDetectInterruptionNode,
    createResolveInterruptionNode,
} from "./nodes/interruptions";
import { createAnswerQuestionsNode, createGatherContextNode, createGenerateTestsNode } from "./nodes/context";
import { createHitlRunNode, createHitlSaveNode } from "./nodes/hitl";
import { createSummarizeNode } from "./nodes/summarize";

export function createAgentGraph(deps: AgentNodeDeps) {
    const graph = new StateGraph(GraphState)
        .addNode("classifyGoal", createClassifyGoalNode(deps))
        .addNode("navigate", createNavigateNode(deps))
        .addNode("detectInterruption", createDetectInterruptionNode(deps))
        .addNode("resolveInterruption", createResolveInterruptionNode(deps))
        .addNode("captureAfterResolve", createCaptureAfterResolveNode(deps))
        .addNode("awaitUser", createAwaitUserNode(deps))
        .addNode("explore", createExploreNode(deps))
        .addNode("gatherContext", createGatherContextNode(deps))
        .addNode("answerQuestions", createAnswerQuestionsNode(deps))
        .addNode("generateTests", createGenerateTestsNode(deps))
        .addNode("hitlSave", createHitlSaveNode(deps))
        .addNode("hitlRun", createHitlRunNode(deps))
        .addNode("summarize", createSummarizeNode())
        .addEdge(START, "classifyGoal")
        .addConditionalEdges(
            "classifyGoal",
            (state: GraphStateType) => {
                if (state.awaitUserMessage) return "awaitUser";
                if (state.nextTool === "discoveryRead") {
                    return "answerQuestions";
                }
                if (
                    state.nextTool === "codeSearch" ||
                    state.nextTool === "testGen" ||
                    state.nextTool === "explain" ||
                    state.nextTool === "none"
                ) {
                    return "gatherContext";
                }
                if (state.nextTool === "domCapture") {
                    return "detectInterruption";
                }
                return "navigate";
            },
            ["awaitUser", "answerQuestions", "gatherContext", "detectInterruption", "navigate"]
        )
        .addEdge("navigate", "detectInterruption")
        .addConditionalEdges(
            "detectInterruption",
            (state: GraphStateType) => {
                if (!state.interruption) return "explore";
                if (state.interruption.requiresUser) return "awaitUser";
                return "resolveInterruption";
            },
            ["resolveInterruption", "awaitUser", "explore"]
        )
        .addEdge("resolveInterruption", "captureAfterResolve")
        .addEdge("captureAfterResolve", "explore")
        .addEdge("awaitUser", END)
        .addEdge("explore", "gatherContext")
        .addConditionalEdges(
            "gatherContext",
            (state: GraphStateType) => {
                if (state.intent === "generateTests") return "generateTests";
                return "answerQuestions";
            },
            ["generateTests", "answerQuestions", "summarize"]
        )
        .addEdge("answerQuestions", "summarize")
        .addEdge("generateTests", "hitlSave")
        .addConditionalEdges(
            "hitlSave",
            (state: GraphStateType) => {
                if (state.shouldPause) return END;
                if (state.shouldRunTests) return "hitlRun";
                return "summarize";
            },
            ["hitlRun", "summarize", END]
        )
        .addConditionalEdges(
            "hitlRun",
            (state: GraphStateType) => (state.shouldPause ? END : "summarize"),
            ["summarize", END]
        )
        .addEdge("summarize", END)
        .compile();

    return graph;
}
