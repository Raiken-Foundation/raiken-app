import { describe, expect, it, vi } from "vitest";

import { routeAfterGoalClassification } from "../agent/graph/graph";
import { createClassifyGoalNode } from "../agent/graph/nodes/classify-goal";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";

function classifierResult(goal: string) {
    return {
        intent: "generateTests" as const,
        goal,
        targetFeature: null,
        targetUrl: "http://localhost:5100",
        targetAction: null,
        performAction: false,
        nextTool: "domCapture" as const,
        missingContext: [],
        shouldRunTests: false,
        isContinuation: false,
    };
}

describe("goal auth precondition classification", () => {
    it("uses the classified goal to identify an MFA login flow", async () => {
        const setAuthPrecondition = vi.fn();
        const model = {
            withStructuredOutput: () => ({
                invoke: async () => classifierResult("complete MFA login with a verification code"),
            }),
        };
        const node = createClassifyGoalNode({
            projectPath: "/test/project",
            model,
            callTool: vi.fn(),
            buildAgentClassifierPrompt: () => "classify",
            setAuthPrecondition,
        } as unknown as AgentNodeDeps);

        const result = await node({
            userPrompt: "generate that next",
            conversationHistory: [],
            pauseReason: null,
            pendingPagesVisited: [],
            pendingPageSummaries: [],
        } as unknown as GraphStateType);

        expect(result["authPrecondition"]).toBe("login_flow");
        expect(setAuthPrecondition).toHaveBeenCalledWith("login_flow");
    });

    it("defaults ordinary protected feature tests to authenticated", async () => {
        const model = {
            withStructuredOutput: () => ({
                invoke: async () => classifierResult("create and edit a project"),
            }),
        };
        const node = createClassifyGoalNode({
            projectPath: "/test/project",
            model,
            callTool: vi.fn(),
            buildAgentClassifierPrompt: () => "classify",
        } as unknown as AgentNodeDeps);

        const result = await node({
            userPrompt: "test project creation",
            conversationHistory: [],
            pauseReason: null,
            pendingPagesVisited: [],
            pendingPageSummaries: [],
        } as unknown as GraphStateType);

        expect(result["authPrecondition"]).toBe("authenticated");
    });
});

describe("discovery management classification", () => {
    it("routes an explicit clear-and-rerun request deterministically", async () => {
        const model = {
            withStructuredOutput: () => ({
                invoke: async () => ({
                    ...classifierResult("understand the application"),
                    intent: "explain" as const,
                    targetUrl: null,
                    nextTool: "discoveryRead" as const,
                    discoveryAction: null,
                }),
            }),
        };
        const node = createClassifyGoalNode({
            projectPath: "/test/project",
            model,
            callTool: vi.fn(),
            buildAgentClassifierPrompt: () => "classify",
        } as unknown as AgentNodeDeps);

        const result = await node({
            userPrompt: "clear the discovery data and do it again",
            conversationHistory: [],
            pauseReason: null,
            pendingPagesVisited: [],
            pendingPageSummaries: [],
        } as unknown as GraphStateType);

        expect(result["nextTool"]).toBe("discoveryManage");
        expect(result["discoveryAction"]).toBe("clearAndStart");
    });

    it("routes discovery management before a misclassified test-generation intent", () => {
        const route = routeAfterGoalClassification({
            intent: "generateTests",
            nextTool: "discoveryManage",
            discoveryAction: "clearAndStart",
            targetUrl: null,
        } as GraphStateType);

        expect(route).toBe("manageDiscovery");
    });
});
