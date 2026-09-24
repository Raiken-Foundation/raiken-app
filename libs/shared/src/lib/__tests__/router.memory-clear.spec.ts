import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectPath, chatHistoryStore } from "@raiken/core";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "../router";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-router-memory-"));
    projects.push(project);
    await fs.mkdir(path.join(project, ".raiken"), { recursive: true });
    return project;
}

function historyFile(project: string): string {
    return path.join(project, ".raiken", "chat-history.json");
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("clearAgentMemory vs clearChatMessages", () => {
    it("clearAgentMemory resets working memory without deleting chat history", async () => {
        const project = await makeProject();
        const key = canonicalProjectPath(project);
        const caller = appRouter.createCaller({ projectPath: project });

        chatHistoryStore.replaceAll(key, [
            {
                id: "one",
                content: "keep me",
                sender: "user",
                timestamp: 1,
            },
        ]);

        const { AgentMemory } = await import("@raiken/core");
        const memory = AgentMemory.getInstance(key);
        memory.initialize();
        memory.setPreference("auth_login", "https://example.test/login");
        memory.setPreference("paused_reason", "needs input");
        memory.setGoalState({
            activeGoal: "test checkout",
            targetFeature: null,
            targetUrl: null,
            missingContext: [],
            nextTool: null,
        });

        await caller.clearAgentMemory();

        expect(chatHistoryStore.list(key)).toHaveLength(1);
        expect(memory.getPreference("auth_login")).toBe("");
        expect(memory.getPreference("paused_reason")).toBe("");
        expect(memory.getGoalState().activeGoal).toBeNull();
    });

    it("clearChatMessages clears chat and agent working memory", async () => {
        const project = await makeProject();
        const key = canonicalProjectPath(project);
        const caller = appRouter.createCaller({ projectPath: project });

        chatHistoryStore.replaceAll(key, [
            {
                id: "one",
                content: "remove me",
                sender: "user",
                timestamp: 1,
            },
        ]);

        const { AgentMemory } = await import("@raiken/core");
        const memory = AgentMemory.getInstance(key);
        memory.initialize();
        memory.setPreference("auth_login", "https://example.test/login");

        await caller.clearChatMessages();

        expect(chatHistoryStore.list(key)).toEqual([]);
        expect(memory.getPreference("auth_login")).toBe("");
        const raw = await fs.readFile(historyFile(project), "utf-8");
        expect(JSON.parse(raw)).toEqual({ messages: [] });
    });

    it("clearAgentMemory preserves learned selectors and action paths", async () => {
        const project = await makeProject();
        const key = canonicalProjectPath(project);
        const caller = appRouter.createCaller({ projectPath: project });

        const { AgentMemory } = await import("@raiken/core");
        const memory = AgentMemory.getInstance(key);
        memory.initialize();
        memory.setPreference(
            "action_path:sign out",
            JSON.stringify({ page: "/home", selector: "#logout" }),
        );
        memory.recordSelectorSuccess("submit button", "#submit", "css");
        memory.setPreference("auth_login", "https://example.test/login");
        memory.setGoalState({
            activeGoal: "test checkout",
            targetFeature: null,
            targetUrl: null,
            missingContext: [],
            nextTool: null,
        });

        await caller.clearAgentMemory();

        expect(memory.getPreference("action_path:sign out")).toBe(
            JSON.stringify({ page: "/home", selector: "#logout" }),
        );
        expect(memory.getBestSelector("submit button")).toMatchObject({
            selector: "#submit",
            selectorType: "css",
        });
        expect(memory.getPreference("auth_login")).toBe("");
        expect(memory.getGoalState().activeGoal).toBeNull();
    });
});
