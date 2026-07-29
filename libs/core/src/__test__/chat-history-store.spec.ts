import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatHistoryStore } from "../chat";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-chat-history-"));
    projects.push(project);
    return project;
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("ChatHistoryStore", () => {
    it("persists, reloads, updates idempotently, and clears project history", async () => {
        const project = await makeProject();
        const store = new ChatHistoryStore();
        const message = {
            id: "one",
            content: "first",
            sender: "user" as const,
            timestamp: 1,
        };
        expect(store.append(project, message)).toBe(1);
        store.append(project, { ...message, content: "updated" });
        expect(new ChatHistoryStore().list(project)).toEqual([{ ...message, content: "updated" }]);
        store.clear(project);
        expect(new ChatHistoryStore().list(project)).toEqual([]);
    });
});
