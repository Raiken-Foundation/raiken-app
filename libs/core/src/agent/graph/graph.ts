import { END, START, StateGraph } from "@langchain/langgraph";
import { createClassifyGoalNode } from "./nodes/classify-goal";
import {
    createAnswerQuestionsNode,
    createGatherContextNode,
    createGenerateTestsNode,
} from "./nodes/context";
import { createManageDiscoveryNode } from "./nodes/discovery-management";
import { createHitlRunNode, createHitlSaveNode } from "./nodes/hitl";
import {
    createAwaitUserNode,
    createCaptureAfterResolveNode,
    createDetectInterruptionNode,
    createResolveInterruptionNode,
} from "./nodes/interruptions";
import { createExploreNode, createNavigateNode } from "./nodes/navigation";
import { createRepairNode, resolveAutonomy, shouldRepair } from "./nodes/repair";
import { createSummarizeNode } from "./nodes/summarize";
import type { AgentNodeDeps } from "./nodes/types";
import { GraphState, type GraphStateType } from "./state";

/**
 * Safety net for classifier misfires: an unambiguous "write/generate a test"
 * request must produce a spec even if the classifier labeled it explain/explore
 * (which would otherwise yield an essay instead of a runnable test).
 */
function userClearlyWantsTest(prompt: string): boolean {
    return /\b(write|generate|create|make|add|build|scaffold)\s+(me\s+|a\s+|an\s+|some\s+)?(e2e\s+|end-to-end\s+|integration\s+|unit\s+|playwright\s+)?tests?\b/i.test(
        prompt,
    );
}

export function routeAfterGoalClassification(state: GraphStateType): string {
    if (state.awaitUserMessage) return "awaitUser";
    // Resuming a live-page blocker (auth/otp/consent/…): go straight
    // back to the interruption path so supplied credentials are used.
    if (state.resumeBlocker) return "detectInterruption";
    // A concrete discovery mutation outranks the broad intent label. A
    // classifier can call a combined request "generateTests"; it must not
    // silently skip an explicit clear/start action.
    if (state.nextTool === "discoveryManage") return "manageDiscovery";
    if (state.intent === "generateTests") {
        if (state.nextTool === "domCapture" || state.targetUrl) return "navigate";
        return "gatherContext";
    }
    if (state.nextTool === "discoveryRead") return "answerQuestions";
    if (
        state.nextTool === "codeSearch" ||
        state.nextTool === "testGen" ||
        state.nextTool === "explain" ||
        state.nextTool === "none"
    ) {
        return "gatherContext";
    }
    if (state.nextTool === "domCapture") return "detectInterruption";
    return "navigate";
}

export function createAgentGraph(deps: AgentNodeDeps) {
    // Resolved once per graph (not per-node) so every routing decision in
    // this run sees the exact same autonomy snapshot.
    const autonomy = resolveAutonomy(deps);
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
        .addNode("manageDiscovery", createManageDiscoveryNode(deps))
        .addNode("generateTests", createGenerateTestsNode(deps))
        .addNode("hitlSave", createHitlSaveNode(deps))
        .addNode("hitlRun", createHitlRunNode(deps))
        .addNode("repair", createRepairNode(deps))
        .addNode("summarize", createSummarizeNode())
        .addEdge(START, "classifyGoal")
        .addConditionalEdges("classifyGoal", routeAfterGoalClassification, [
            "awaitUser",
            "answerQuestions",
            "manageDiscovery",
            "gatherContext",
            "detectInterruption",
            "navigate",
        ])
        .addConditionalEdges(
            "navigate",
            (state: GraphStateType) => {
                // If navigation couldn't proceed (no URL / load failure), stop
                // now rather than running detect→explore→…→summarize on a page
                // that never loaded and only surfacing the pause at the end.
                if (state.shouldPause || state.awaitUserMessage) return "awaitUser";
                // Optional grounding failed (app down) → generate from code.
                if (state.groundingFailed) return "gatherContext";
                return "detectInterruption";
            },
            ["awaitUser", "detectInterruption", "gatherContext"],
        )
        .addConditionalEdges(
            "detectInterruption",
            (state: GraphStateType) => {
                if (!state.interruption) return "explore";
                if (state.interruption.requiresUser) return "awaitUser";
                return "resolveInterruption";
            },
            ["resolveInterruption", "awaitUser", "explore"],
        )
        .addConditionalEdges(
            "resolveInterruption",
            (state: GraphStateType) => {
                if (state.shouldPause || state.awaitUserMessage) return "awaitUser";
                return "captureAfterResolve";
            },
            ["awaitUser", "captureAfterResolve"],
        )
        .addEdge("captureAfterResolve", "explore")
        .addEdge("awaitUser", END)
        .addConditionalEdges(
            "explore",
            (state: GraphStateType) => {
                if (state.interruption) {
                    if (state.interruption.requiresUser) return "awaitUser";
                    return "resolveInterruption";
                }
                return "gatherContext";
            },
            ["awaitUser", "resolveInterruption", "gatherContext"],
        )
        .addConditionalEdges(
            "gatherContext",
            (state: GraphStateType) => {
                if (state.intent === "generateTests") return "generateTests";
                // Misclassification safety net: honor an explicit test request.
                if (userClearlyWantsTest(state.userPrompt)) return "generateTests";
                return "answerQuestions";
            },
            ["generateTests", "answerQuestions", "summarize"],
        )
        .addEdge("answerQuestions", "summarize")
        .addConditionalEdges(
            "manageDiscovery",
            (state: GraphStateType) => {
                if (state.shouldPause || state.awaitUserMessage) return "awaitUser";
                return "summarize";
            },
            ["awaitUser", "summarize"],
        )
        .addEdge("generateTests", "hitlSave")
        .addConditionalEdges(
            "hitlSave",
            (state: GraphStateType) => {
                if (state.shouldPause) return END;
                if (state.shouldRunTests) return "hitlRun";
                return "summarize";
            },
            ["hitlRun", "summarize", END],
        )
        .addConditionalEdges(
            "hitlRun",
            (state: GraphStateType) => {
                if (state.shouldPause) return END;
                if (shouldRepair(state, autonomy)) return "repair";
                return "summarize";
            },
            ["repair", "summarize", END],
        )
        .addConditionalEdges(
            "repair",
            (state: GraphStateType) => {
                if (state.shouldPause) return END;
                return "hitlRun";
            },
            ["hitlRun", END],
        )
        .addEdge("summarize", END)
        .compile();

    return graph;
}
