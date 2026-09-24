import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatHistoryStore } from "../../chat/chat-history-store";
import { ChatApplication } from "../chat";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-app-chat-"));
    projects.push(project);
    await fs.mkdir(path.join(project, ".raiken"), { recursive: true });
    return project;
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("ChatApplication contract", () => {
    it("clearAgentMemory resets working memory without deleting chat history", async () => {
        const project = await makeProject();
        const chat = new ChatApplication(project);

        chatHistoryStore.replaceAll(project, [
            { id: "one", content: "keep me", sender: "user", timestamp: 1 },
        ]);

        const { AgentMemory } = await import("../../agent/memory");
        const memory = AgentMemory.getInstance(project);
        memory.initialize();
        memory.setPreference("auth_login", "https://example.test/login");
        memory.setGoalState({
            activeGoal: "test checkout",
            targetFeature: null,
            targetUrl: null,
            missingContext: [],
            nextTool: null,
        });

        chat.clearAgentMemory();

        expect(chatHistoryStore.list(project)).toHaveLength(1);
        expect(memory.getPreference("auth_login")).toBe("");
        expect(memory.getGoalState().activeGoal).toBeNull();
    });

    it("clearChatMessages clears chat and agent working memory", async () => {
        const project = await makeProject();
        const chat = new ChatApplication(project);

        chatHistoryStore.replaceAll(project, [
            { id: "one", content: "remove me", sender: "user", timestamp: 1 },
        ]);

        const { AgentMemory } = await import("../../agent/memory");
        const memory = AgentMemory.getInstance(project);
        memory.initialize();
        memory.setPreference("auth_login", "https://example.test/login");

        chat.clearChatMessages();

        expect(chatHistoryStore.list(project)).toEqual([]);
        expect(memory.getPreference("auth_login")).toBe("");
    });
});
