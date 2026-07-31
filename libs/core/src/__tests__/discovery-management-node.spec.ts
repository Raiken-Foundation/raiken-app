import { describe, expect, it, vi } from "vitest";

import {
    createManageDiscoveryNode,
    inferDiscoveryManagementAction,
} from "../agent/graph/nodes/discovery-management";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";
import type { ToolResult } from "../agent/tools";

function state(overrides: Partial<GraphStateType>): GraphStateType {
    return {
        userPrompt: "",
        discoveryAction: null,
        targetUrl: null,
        ...overrides,
    } as GraphStateType;
}

function deps(callTool: (name: string, args: unknown) => Promise<ToolResult>): AgentNodeDeps {
    return { callTool } as unknown as AgentNodeDeps;
}

describe("discovery management routing", () => {
    it.each([
        ["clear the discovery data", "clear"],
        ["delete all site discovery results", "clear"],
        ["run discovery again", "start"],
        ["restart the crawl", "start"],
        ["clear discovery data and do it again", "clearAndStart"],
        ["show me the discovered pages", null],
        ["remove auth blockers from discovery", null],
        ["delete the discovery session row", null],
        ["crawl the codebase for login flows", null],
    ] as const)("%s -> %s", (prompt, expected) => {
        expect(inferDiscoveryManagementAction(prompt)).toBe(expected);
    });

    it("clears and restarts from the previous session URL", async () => {
        const callTool = vi.fn(async (name: string): Promise<ToolResult> => {
            if (name === "getDiscoveryOverview") {
                return {
                    success: true,
                    data: {
                        latestSession: { startUrl: "http://127.0.0.1:5100" },
                    },
                    message: "Loaded discovery overview",
                };
            }
            if (name === "clearDiscoveryData") {
                return { success: true, message: "Discovery data cleared" };
            }
            if (name === "startDiscovery") {
                return {
                    success: true,
                    data: { phase: "running" },
                    message: "Discovery started",
                };
            }
            throw new Error(`Unexpected tool: ${name}`);
        });
        const node = createManageDiscoveryNode(deps(callTool));

        const result = await node(
            state({
                userPrompt: "clear the discovery data and do it again",
                discoveryAction: "clearAndStart",
            }),
        );

        expect(callTool.mock.calls).toEqual([
            ["getDiscoveryOverview", {}],
            ["clearDiscoveryData", {}],
            ["startDiscovery", { url: "http://127.0.0.1:5100/" }],
        ]);
        expect(result.summary).toContain("cleared");
        expect(result.summary).toContain("started");
        expect(result.summary).toContain("http://127.0.0.1:5100");
    });

    it("reports a missing URL before clearing when no prior URL can be recovered", async () => {
        const callTool = vi.fn(
            async (): Promise<ToolResult> => ({
                success: true,
                data: { latestSession: null },
                message: "No discovery data found",
            }),
        );
        const node = createManageDiscoveryNode(deps(callTool));

        const result = await node(
            state({
                userPrompt: "clear discovery and rerun it",
                discoveryAction: "clearAndStart",
            }),
        );

        expect(callTool).toHaveBeenCalledTimes(1);
        expect(result.shouldPause).toBeUndefined();
        expect(result.summary).toContain("no previous start URL");
        expect(result.summary).toContain("No discovery data was cleared");
        expect(result.summary).toContain("Repeat the request with the full URL");
    });

    it("never clears data unless the current user prompt explicitly requests deletion", async () => {
        const callTool = vi.fn();
        const node = createManageDiscoveryNode(deps(callTool));

        const result = await node(
            state({
                userPrompt: "show the discovery overview",
                discoveryAction: "clear",
            }),
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(result.summary).toContain("did not clear");
        expect(result.summary).toContain("explicitly");
    });

    it("reports tool failures and does not claim the operation succeeded", async () => {
        const callTool = vi.fn(
            async (): Promise<ToolResult> => ({
                success: false,
                message: "database is locked",
            }),
        );
        const node = createManageDiscoveryNode(deps(callTool));

        const result = await node(
            state({
                userPrompt: "clear discovery data",
                discoveryAction: "clear",
            }),
        );

        expect(result.summary).toContain("could not clear");
        expect(result.summary).toContain("database is locked");
        expect(result.summary).not.toContain("successfully");
    });

    it("distinguishes an overview read failure from a missing URL", async () => {
        const callTool = vi.fn(
            async (): Promise<ToolResult> => ({
                success: false,
                message: "database is locked",
            }),
        );
        const node = createManageDiscoveryNode(deps(callTool));

        const result = await node(
            state({
                userPrompt: "clear discovery and rerun it",
                discoveryAction: "clearAndStart",
            }),
        );

        expect(result.summary).toContain("could not recover the previous discovery URL");
        expect(result.summary).toContain("database is locked");
        expect(result.summary).not.toContain("need the full URL");
    });
});
