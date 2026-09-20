/**
 * Tool-group contract / parity tests for the decomposed agent tools factory.
 *
 * Locks registry names, schema surfaces, representative I/O, callback order,
 * and error shapes per capability group without reaching into implementation
 * details that belong in integration tests.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import * as application from "../../../application";
import { defaultConfig } from "../../../config";
import { AgentMemory } from "../../memory";
import { createAgentTools } from "../../tools";
import {
    AGENT_TOOL_GROUP_REGISTRY,
    AGENT_TOOL_REGISTRY_ORDER,
    BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
    createBrowserNavigationInteractionTools,
    createDiscoveryKnowledgeTools,
    createFilesystemTestArtifactTools,
    createMemoryTerminalControlTools,
    createTestExecutionRepairTools,
    DISCOVERY_KNOWLEDGE_TOOL_NAMES,
    FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES,
    MEMORY_TERMINAL_CONTROL_TOOL_NAMES,
    TEST_EXECUTION_REPAIR_TOOL_NAMES,
} from "../registry";
import type { AgentToolGroupDeps, AutonomySettings, ToolResult } from "../types";

function callToolExecute<T>(fn: unknown, args: unknown): Promise<ToolResult<T>> {
    return (fn as (args: unknown) => Promise<ToolResult<T>>)(args);
}

function defaultDeps(
    projectPath: string,
    overrides: Partial<AgentToolGroupDeps> = {},
): AgentToolGroupDeps {
    return {
        projectPath,
        autonomy: defaultConfig.autonomy as AutonomySettings,
        operationHeld: false,
        isActionAuthorized: () => false,
        getAuthPrecondition: () => "authenticated",
        ...overrides,
    };
}

type ToolWithSchema = { inputSchema?: z.ZodTypeAny };

function parseToolInput(tool: ToolWithSchema, input: unknown) {
    const schema = tool.inputSchema;
    if (!schema) {
        throw new Error("tool has no inputSchema");
    }
    return schema.parse(input);
}

describe("agent tool group registry contracts", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-tool-contract-"));
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("assigns disjoint tool name sets to each group", () => {
        const all = Object.values(AGENT_TOOL_GROUP_REGISTRY).flat();
        expect(new Set(all).size).toBe(all.length);
    });

    it("defines AGENT_TOOL_REGISTRY_ORDER without duplicates", () => {
        expect(new Set(AGENT_TOOL_REGISTRY_ORDER).size).toBe(AGENT_TOOL_REGISTRY_ORDER.length);
    });

    it("unions group registries into the composed registry order", () => {
        const union = new Set(Object.values(AGENT_TOOL_GROUP_REGISTRY).flat());
        for (const name of AGENT_TOOL_REGISTRY_ORDER) {
            expect(union.has(name)).toBe(true);
        }
        expect(union.size).toBe(AGENT_TOOL_REGISTRY_ORDER.length);
    });

    it.each([
        [
            "filesystemTestArtifact",
            FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES,
            createFilesystemTestArtifactTools,
        ] as const,
        [
            "discoveryKnowledge",
            DISCOVERY_KNOWLEDGE_TOOL_NAMES,
            createDiscoveryKnowledgeTools,
        ] as const,
        [
            "testExecutionRepair",
            TEST_EXECUTION_REPAIR_TOOL_NAMES,
            createTestExecutionRepairTools,
        ] as const,
        [
            "memoryTerminalControl",
            MEMORY_TERMINAL_CONTROL_TOOL_NAMES,
            createMemoryTerminalControlTools,
        ] as const,
        [
            "browserNavigationInteraction",
            BROWSER_NAVIGATION_INTERACTION_TOOL_NAMES,
            createBrowserNavigationInteractionTools,
        ] as const,
    ])("%s factory keys match its registry", (_label, expected, factory) => {
        const tools = factory(defaultDeps(projectPath));
        expect(Object.keys(tools).sort()).toEqual([...expected].sort());
    });

    it("createAgentTools exposes tools in AGENT_TOOL_REGISTRY_ORDER", () => {
        const tools = createAgentTools({ projectPath });
        expect(Object.keys(tools)).toEqual([...AGENT_TOOL_REGISTRY_ORDER]);
    });

    it.each([...AGENT_TOOL_REGISTRY_ORDER])("tool %s has a non-empty description", (name) => {
        const tools = createAgentTools({ projectPath });
        const tool = tools[name as keyof typeof tools] as { description?: string };
        expect(typeof tool.description).toBe("string");
        expect(tool.description?.length).toBeGreaterThan(0);
    });

    it.each([
        ["readFile", { filePath: "src/app.ts" }],
        ["searchCodebase", { query: "login", limit: 5 }],
        ["listDirectory", { dirPath: "src" }],
        ["saveFile", { filePath: "e2e/x.spec.ts", content: "test()" }],
        ["runTest", { testFile: "e2e/x.spec.ts", headed: false }],
        ["captureDOM", { url: "http://localhost:3000/" }],
        ["clearDiscoveryData", {}],
        [
            "startDiscovery",
            {
                url: "http://localhost:3000/",
                maxPages: 25,
                maxDepth: 3,
                timeout: 60_000,
            },
        ],
        ["navigateTo", { url: "http://localhost:3000/login" }],
        ["clickElement", { selector: "#submit" }],
        ["fillInput", { selector: "#email", value: "a@b.com" }],
        ["typeText", { selector: "#name", text: "Alice" }],
        ["waitForElement", { selector: ".modal", timeout: 3000 }],
        ["selectOption", { selector: "select#role", value: "admin" }],
        ["toggleCheckbox", { selector: "#terms", checked: true }],
        ["discoverLinks", { includeExternal: false }],
        ["done", { summary: "Explored login flow" }],
        ["awaitUser", { message: "Continue?" }],
    ] as const)("schema accepts representative input for %s", (name, input) => {
        const tools = createAgentTools({ projectPath });
        const tool = tools[name as keyof typeof tools] as ToolWithSchema;
        expect(() => parseToolInput(tool, input)).not.toThrow();
    });

    it.each([
        ["readFile", {}],
        ["navigateTo", { url: "not-a-url" }],
        ["fillInput", { selector: "#x" }],
    ] as const)("schema rejects invalid input for %s", (name, input) => {
        const tools = createAgentTools({ projectPath });
        const tool = tools[name as keyof typeof tools] as ToolWithSchema;
        expect(() => parseToolInput(tool, input)).toThrow();
    });
});

describe("filesystem / test-artifact group contract", () => {
    let projectPath: string;
    let tools: ReturnType<typeof createFilesystemTestArtifactTools>;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-fs-tools-"));
        fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
        fs.writeFileSync(path.join(projectPath, "src", "app.ts"), "export const app = 1;\n");
        tools = createFilesystemTestArtifactTools(defaultDeps(projectPath));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("readFile returns content for an existing file", async () => {
        const result = await callToolExecute<{ content: string; lines: number }>(
            tools.readFile.execute,
            { filePath: "src/app.ts" },
        );
        expect(result.success).toBe(true);
        expect(result.data?.content).toContain("export const app");
        expect(result.message).toMatch(/Read src\/app.ts/);
    });

    it("readFile rejects path traversal", async () => {
        const result = await callToolExecute(tools.readFile.execute, {
            filePath: "../../../etc/passwd",
        });
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Path traversal denied|Failed to read file/);
    });

    it("listDirectory lists entries with trailing slash for directories", async () => {
        const result = await callToolExecute<string[]>(tools.listDirectory.execute, {
            dirPath: "src",
        });
        expect(result.success).toBe(true);
        expect(result.data).toContain("app.ts");
    });

    it("saveFile returns HITL when autoSaveTests is off", async () => {
        const result = await callToolExecute<{ path: string; saved: boolean }>(
            tools.saveFile.execute,
            {
                filePath: "e2e/example.spec.ts",
                content: "test('x', () => {});",
                testName: "example",
            },
        );
        expect(result.success).toBe(true);
        expect(result.data?.saved).toBe(false);
        expect(result.hitlRequired).toBe(true);
        expect(result.hitlAction?.type).toBe("save");
        expect(result.message).toMatch(/Waiting for confirmation/);
    });
});

describe("discovery / knowledge group contract", () => {
    let projectPath: string;
    let tools: ReturnType<typeof createDiscoveryKnowledgeTools>;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-discovery-tools-"));
        tools = createDiscoveryKnowledgeTools(
            defaultDeps(projectPath, { isActionAuthorized: () => true }),
        );
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("getDiscoveryOverview succeeds on an empty project", async () => {
        const result = await callToolExecute(tools.getDiscoveryOverview.execute, {});
        expect(result.success).toBe(true);
        expect(result.data?.stats.pagesCount).toBe(0);
        expect(result.message).toMatch(/No discovery data found/);
    });

    it("listDiscoveredPages returns pagination defaults", async () => {
        const result = await callToolExecute(tools.listDiscoveredPages.execute, {});
        expect(result.success).toBe(true);
        expect(result.data?.limit).toBe(20);
        expect(result.data?.offset).toBe(0);
        expect(result.data?.pages).toEqual([]);
        expect(result.data?.total).toBe(0);
    });

    it("getDiscoveredPageSnapshot returns null data when URL is unknown", async () => {
        const result = await callToolExecute(tools.getDiscoveredPageSnapshot.execute, {
            url: "https://example.com/missing",
        });
        expect(result.success).toBe(true);
        expect(result.data).toBeNull();
        expect(result.message).toMatch(/No discovered snapshot found/);
    });

    it("clearDiscoveryData delegates to the lifecycle-safe application service", async () => {
        const clearData = vi.fn().mockResolvedValue({
            success: true,
            message: "Discovery data cleared successfully",
            runtime: { phase: "idle" },
        });
        vi.spyOn(application, "getProjectApplication").mockReturnValue({
            discovery: { clearData },
        } as never);

        const result = await callToolExecute(tools.clearDiscoveryData.execute, {});

        expect(clearData).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            success: true,
            message: "Discovery data cleared successfully",
            data: { phase: "idle" },
        });
    });

    it("clearDiscoveryData refuses deletion without current-request authorization", async () => {
        const unauthorized = createDiscoveryKnowledgeTools(defaultDeps(projectPath));
        const clearData = vi.fn();
        vi.spyOn(application, "getProjectApplication").mockReturnValue({
            discovery: { clearData },
        } as never);

        const result = await callToolExecute(unauthorized.clearDiscoveryData.execute, {});

        expect(result.success).toBe(false);
        expect(result.message).toContain("did not explicitly authorize");
        expect(clearData).not.toHaveBeenCalled();
    });

    it("startDiscovery launches detached discovery with validated limits", async () => {
        tools = createDiscoveryKnowledgeTools(
            defaultDeps(projectPath, {
                isActionAuthorized: () => true,
                operationHeld: true,
            }),
        );
        const start = vi.fn().mockResolvedValue({
            success: true,
            message: "Discovery started",
            runtime: { phase: "running", currentUrl: "http://localhost:3000/" },
        });
        vi.spyOn(application, "getProjectApplication").mockReturnValue({
            discovery: { start },
        } as never);

        const result = await callToolExecute(tools.startDiscovery.execute, {
            url: "http://localhost:3000/",
            maxPages: 25,
            maxDepth: 3,
            timeout: 60_000,
        });

        expect(start).toHaveBeenCalledWith({
            url: "http://localhost:3000/",
            maxPages: 25,
            maxDepth: 3,
            timeout: 60_000,
        });
        expect(result).toMatchObject({
            success: true,
            message: "Discovery started",
            data: {
                phase: "running",
                currentUrl: "http://localhost:3000/",
            },
        });
    });

    it("startDiscovery rejects malformed URLs and non-positive limits", () => {
        expect(() =>
            parseToolInput(tools.startDiscovery, {
                url: "not-a-url",
                maxPages: 0,
            }),
        ).toThrow();
    });
});

describe("test execution / repair group contract", () => {
    let projectPath: string;
    let tools: ReturnType<typeof createTestExecutionRepairTools>;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-run-tools-"));
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(path.join(projectPath, "e2e", "a.spec.ts"), "test('a', () => {});");
        tools = createTestExecutionRepairTools(defaultDeps(projectPath));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("runTest rejects paths outside the project", async () => {
        const result = await callToolExecute(tools.runTest.execute, {
            testFile: "../../../etc/passwd",
        });
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Path traversal denied|Invalid test file path/);
    });

    it("runTest returns HITL when autoRunTests is off", async () => {
        const result = await callToolExecute(tools.runTest.execute, { testFile: "e2e/a.spec.ts" });
        expect(result.success).toBe(true);
        expect(result.hitlRequired).toBe(true);
        expect(result.hitlAction?.type).toBe("run");
        expect(result.data).toEqual({ status: "pending" });
        expect(result.message).toMatch(/Waiting for confirmation/);
    });

    it("executeTestRun delegates to TestRunner when auto-approved", async () => {
        const { executeTestRun } = await import("../test-execution-repair");
        const { TestRunner } = await import("../../../testing/runner");
        const runTestSpy = vi
            .spyOn(TestRunner.prototype, "runTest")
            .mockResolvedValue([{ status: "passed", title: "a", duration: 12 }]);

        try {
            const result = await executeTestRun(projectPath, "e2e/a.spec.ts", false, {
                autoLearn: "off",
            });
            expect(runTestSpy).toHaveBeenCalledWith("e2e/a.spec.ts", expect.any(Object));
            expect(result.success).toBe(true);
            expect(result.message).toMatch(/All tests passed/);
        } finally {
            runTestSpy.mockRestore();
        }
    });
});

describe("memory / terminal / control group contract", () => {
    let projectPath: string;
    let tools: ReturnType<typeof createMemoryTerminalControlTools>;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-memory-tools-"));
        tools = createMemoryTerminalControlTools(defaultDeps(projectPath));
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("getMemoryContext returns an empty memory surface on a fresh project", async () => {
        const result = await callToolExecute(tools.getMemoryContext.execute, {});
        expect(result.success).toBe(true);
        expect(result.data?.successfulSelectors).toEqual([]);
        expect(result.data?.recentFailures).toEqual([]);
    });

    it("done and awaitUser have no execute (terminal loop tools)", () => {
        expect(tools.done.execute).toBeUndefined();
        expect(tools.awaitUser.execute).toBeUndefined();
    });
});

describe("browser / navigation / interaction group contract", () => {
    let projectPath: string;
    let tools: ReturnType<typeof createBrowserNavigationInteractionTools>;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-browser-tools-"));
        tools = createBrowserNavigationInteractionTools(defaultDeps(projectPath));
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("getCurrentUrl fails when the browser session is not active", async () => {
        const result = await callToolExecute(tools.getCurrentUrl.execute, {});
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Failed to get URL/);
    });

    it("closeBrowser succeeds when no session is active", async () => {
        const result = await callToolExecute(tools.closeBrowser.execute, {});
        expect(result.success).toBe(true);
        expect(result.data?.closed).toBe(true);
    });
});
