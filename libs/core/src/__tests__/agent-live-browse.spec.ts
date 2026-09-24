/**
 * F5 — live-page resolution without configured auth: a cold project with no
 * auth.baseUrl must still resolve a live-page prompt to the Playwright
 * config's baseURL (mirroring cover) instead of landing on about:blank, and a
 * failed navigation must pause with a clear message rather than crawl a blank
 * page.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClassifyGoalNode } from "../agent/graph/nodes/classify-goal";
import { createNavigateNode } from "../agent/graph/nodes/navigation";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";

function writePlaywrightConfig(projectPath: string, baseURL: string): void {
    fs.writeFileSync(
        path.join(projectPath, "playwright.config.ts"),
        `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "${baseURL}" },
});
`,
    );
}

function classifierResult(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        intent: "generateTests" as const,
        goal: "generate a test for the login flow",
        targetFeature: null,
        targetUrl: null,
        targetAction: null,
        performAction: false,
        nextTool: "none" as const,
        missingContext: [],
        shouldRunTests: false,
        isContinuation: false,
        ...overrides,
    };
}

function baseDeps(projectPath: string, model: unknown): AgentNodeDeps {
    return {
        projectPath,
        model,
        callTool: vi.fn(),
        buildAgentClassifierPrompt: () => "classify",
    } as unknown as AgentNodeDeps;
}

const emptyState = {
    userPrompt: "generate a test for the login flow",
    conversationHistory: [],
    pauseReason: null,
    pendingPagesVisited: [],
    pendingPageSummaries: [],
} as unknown as GraphStateType;

describe("agent live-page resolution (F5)", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-live-browse-")));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("classifier falls back to the Playwright baseURL when no URL is named or remembered", async () => {
        writePlaywrightConfig(projectDir, "http://localhost:5173");
        const model = {
            withStructuredOutput: () => ({
                invoke: async () => classifierResult(),
            }),
        };
        const node = createClassifyGoalNode(baseDeps(projectDir, model));

        const result = await node(emptyState);

        expect(result["targetUrl"]).toBe("http://localhost:5173");
        expect(result["groundingOptional"]).toBe(true);
    });

    it("classifier fills the baseURL for explore intent too (browse the dashboard)", async () => {
        writePlaywrightConfig(projectDir, "http://localhost:5173");
        const model = {
            withStructuredOutput: () => ({
                invoke: async () =>
                    classifierResult({
                        intent: "explore",
                        goal: "browse the dashboard and describe what you see",
                        nextTool: "domCapture",
                    }),
            }),
        };
        const node = createClassifyGoalNode(baseDeps(projectDir, model));

        const result = await node(emptyState);

        expect(result["targetUrl"]).toBe("http://localhost:5173");
        // Browse is a hard requirement, not an optimization: a down app must
        // pause and say so, not silently answer from code.
        expect(result["groundingOptional"]).toBeUndefined();
    });

    it("classifier prefers a remembered base over the Playwright config", async () => {
        writePlaywrightConfig(projectDir, "http://localhost:5173");
        const { AgentMemory } = await import("../agent/memory");
        AgentMemory.getInstance(projectDir).setPreference(
            "project_base_url",
            "http://app.internal:9999",
        );
        try {
            const model = {
                withStructuredOutput: () => ({
                    invoke: async () => classifierResult(),
                }),
            };
            const node = createClassifyGoalNode(baseDeps(projectDir, model));
            const result = await node(emptyState);
            expect(result["targetUrl"]).toBe("http://app.internal:9999");
        } finally {
            AgentMemory.clearInstances();
        }
    });

    it("navigate node opens the Playwright baseURL when nothing else resolves", async () => {
        writePlaywrightConfig(projectDir, "http://localhost:5173");
        const callTool = vi.fn(async () => ({
            success: true,
            data: { summary: "login page", url: "http://localhost:5173/login" },
        }));
        const node = createNavigateNode({
            projectPath: projectDir,
            callTool,
            onProgress: vi.fn(),
        } as unknown as AgentNodeDeps);

        const result = await node(emptyState);

        expect(callTool).toHaveBeenCalledWith("navigateTo", { url: "http://localhost:5173" });
        expect(result["currentUrl"]).toBe("http://localhost:5173/login");
    });

    it("navigateTo failure pauses with a clear message instead of crawling a blank page", async () => {
        writePlaywrightConfig(projectDir, "http://localhost:5173");
        const callTool = vi.fn(async () => ({
            success: false,
            message: "ECONNREFUSED localhost:5173",
        }));
        const node = createNavigateNode({
            projectPath: projectDir,
            callTool,
            onProgress: vi.fn(),
        } as unknown as AgentNodeDeps);

        const result = await node(emptyState);

        expect(callTool).toHaveBeenCalledWith("navigateTo", { url: "http://localhost:5173" });
        expect(result["shouldPause"]).toBe(true);
        expect(result["awaitUserMessage"]).toContain("http://localhost:5173");
        expect(result["awaitUserMessage"]).toContain("ECONNREFUSED");
        expect(result["pagesVisited"]).toEqual([]);
        expect(result["pageSummaries"]).toEqual([]);
    });

    it("recovers from a stale remembered origin by retrying the Playwright baseURL once", async () => {
        writePlaywrightConfig(projectDir, "http://127.0.0.1:5180");
        const { AgentMemory } = await import("../agent/memory");
        // The dev server moved ports; project_base_url still points at the old one.
        AgentMemory.getInstance(projectDir).setPreference(
            "project_base_url",
            "http://127.0.0.1:5173",
        );
        try {
            const callTool = vi
                .fn()
                .mockResolvedValueOnce({ success: false, message: "ECONNREFUSED 5173" })
                .mockResolvedValueOnce({
                    success: true,
                    data: { summary: "dashboard", url: "http://127.0.0.1:5180/dashboard" },
                });
            const node = createNavigateNode({
                projectPath: projectDir,
                callTool,
                onProgress: vi.fn(),
            } as unknown as AgentNodeDeps);

            const result = await node(emptyState);

            expect(callTool).toHaveBeenNthCalledWith(1, "navigateTo", {
                url: "http://127.0.0.1:5173",
            });
            expect(callTool).toHaveBeenNthCalledWith(2, "navigateTo", {
                url: "http://127.0.0.1:5180",
            });
            expect(result["currentUrl"]).toBe("http://127.0.0.1:5180/dashboard");
            expect(result["domSummary"]).toBe("dashboard");
            expect(result["shouldPause"]).toBeUndefined();
        } finally {
            AgentMemory.clearInstances();
        }
    });

    it("names both attempts when the config retry also fails", async () => {
        writePlaywrightConfig(projectDir, "http://127.0.0.1:5180");
        const { AgentMemory } = await import("../agent/memory");
        AgentMemory.getInstance(projectDir).setPreference(
            "project_base_url",
            "http://127.0.0.1:5173",
        );
        try {
            const callTool = vi.fn(async () => ({
                success: false,
                message: "ECONNREFUSED",
            }));
            const node = createNavigateNode({
                projectPath: projectDir,
                callTool,
                onProgress: vi.fn(),
            } as unknown as AgentNodeDeps);

            const result = await node(emptyState);

            expect(callTool).toHaveBeenCalledTimes(2);
            expect(result["shouldPause"]).toBe(true);
            expect(result["awaitUserMessage"]).toContain("http://127.0.0.1:5173");
            expect(result["awaitUserMessage"]).toContain("Also tried http://127.0.0.1:5180");
        } finally {
            AgentMemory.clearInstances();
        }
    });
});
