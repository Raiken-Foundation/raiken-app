import { describe, expect, it } from "vitest";
import { handleMcpMessage } from "../mcp";

function fakeApp() {
    return {
        projectPath: "/fake",
        contract: {
            view: () => ({
                projectPath: "/fake",
                observed: [],
                intent: [],
                coverage: { total: 2, covered: 1, uncovered: 1, violated: 0, neverRegressUncovered: 0, entries: [], computedAt: 1 },
                exportedAt: 1,
            }),
            coverage: () => ({ total: 2, covered: 1, uncovered: 1, violated: 0, neverRegressUncovered: 0, entries: [], computedAt: 1 }),
            materialize: () => ({ specPath: "/fake/out/contract.spec.ts", testCount: 3, skipped: 0 }),
        },
    } as never;
}

describe("mcp handler", () => {
    it("initializes with the tools capability", async () => {
        const res = await handleMcpMessage({ method: "initialize", id: 1 }, fakeApp());
        expect(res).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    });

    it("lists the contract tools", async () => {
        const res = await handleMcpMessage({ method: "tools/list", id: 2 }, fakeApp());
        const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
        expect(names).toContain("contract_view");
        expect(names).toContain("contract_coverage");
        expect(names).toContain("contract_changes");
        expect(names).toContain("contract_facts");
        expect(names).toContain("contract_requirements");
        expect(names).toContain("contract_materialize");
    });

    it("calls a tool and wraps the result in text content", async () => {
        const res = await handleMcpMessage(
            { method: "tools/call", id: 3, params: { name: "contract_coverage", arguments: {} } },
            fakeApp(),
        );
        const content = (res?.result as { content: Array<{ type: string; text: string }> }).content;
        expect(content[0].type).toBe("text");
        expect(content[0].text).toContain("covered");
    });

    it("errors on unknown tools and methods", async () => {
        const tool = await handleMcpMessage(
            { method: "tools/call", id: 4, params: { name: "nope" } },
            fakeApp(),
        );
        expect(tool?.error).toMatchObject({ code: -32602 });
        const method = await handleMcpMessage({ method: "bogus", id: 5 }, fakeApp());
        expect(method?.error).toMatchObject({ code: -32601 });
    });

    it("is silent for initialized notifications", async () => {
        expect(await handleMcpMessage({ method: "notifications/initialized" }, fakeApp())).toBeNull();
    });
});
