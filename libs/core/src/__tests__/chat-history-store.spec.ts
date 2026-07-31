import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    ChatHistoryStore,
    chatHistoryStore,
    fromLegacyChatMessage,
    toLegacyChatMessage,
} from "../chat";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-chat-history-"));
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

    it("migrates legacy {role, content} messages to canonical schema on read", async () => {
        const project = await makeProject();
        const legacy = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ];
        await fs.writeFile(
            historyFile(project),
            JSON.stringify({ messages: legacy }, null, 2),
            "utf-8",
        );

        const store = new ChatHistoryStore();
        const migrated = store.list(project);

        expect(migrated).toHaveLength(2);
        expect(migrated[0]).toMatchObject({
            sender: "user",
            content: "hello",
        });
        expect(migrated[1]).toMatchObject({
            sender: "assistant",
            content: "hi there",
        });
        expect(migrated[0]?.timestamp).toBeLessThan(migrated[1]?.timestamp ?? 0);

        const onDisk = JSON.parse(await fs.readFile(historyFile(project), "utf-8")) as {
            messages: Array<{ sender: string; role?: string }>;
        };
        expect(
            onDisk.messages.every((message) => "sender" in message && !("role" in message)),
        ).toBe(true);
    });

    it("preserves ordering and content across legacy migration and round-trip helpers", async () => {
        const project = await makeProject();
        const legacy = [
            { role: "user", content: "first turn" },
            { role: "assistant", content: "second turn" },
            { role: "user", content: "third turn" },
        ];
        await fs.writeFile(historyFile(project), JSON.stringify({ messages: legacy }), "utf-8");

        const canonical = new ChatHistoryStore().list(project);
        const roundTrip = canonical.map(toLegacyChatMessage);

        expect(roundTrip).toEqual(legacy);
    });

    it("reflects external file modifications instead of serving stale cache", async () => {
        const project = await makeProject();
        const storeA = new ChatHistoryStore();
        storeA.append(project, {
            id: "a",
            content: "from A",
            sender: "user",
            timestamp: 1,
        });

        const storeB = new ChatHistoryStore();
        storeB.append(project, {
            id: "b",
            content: "from B",
            sender: "assistant",
            timestamp: 2,
        });

        expect(storeA.list(project)).toEqual([
            { id: "a", content: "from A", sender: "user", timestamp: 1 },
            { id: "b", content: "from B", sender: "assistant", timestamp: 2 },
        ]);
    });

    it("supports dashboard-to-REPL continuity via shared canonical file", async () => {
        const project = await makeProject();
        chatHistoryStore.replaceAll(project, [
            {
                id: "dash-1",
                content: "dashboard wrote this",
                sender: "user",
                timestamp: 100,
            },
        ]);

        const replView = chatHistoryStore.list(project).map(toLegacyChatMessage);
        expect(replView).toEqual([{ role: "user", content: "dashboard wrote this" }]);

        chatHistoryStore.replaceAll(project, [
            {
                id: "repl-1",
                content: "repl wrote this",
                sender: "assistant",
                timestamp: 200,
            },
        ]);

        expect(chatHistoryStore.list(project)[0]?.content).toBe("repl wrote this");
    });

    it("migrates mixed legacy and canonical messages in order without dropping canonical rows", async () => {
        const project = await makeProject();
        const mixed = [
            { role: "user", content: "legacy first" },
            {
                id: "canonical-1",
                content: "already canonical",
                sender: "assistant",
                timestamp: 50,
            },
            { role: "user", content: "legacy second" },
        ];
        await fs.writeFile(historyFile(project), JSON.stringify({ messages: mixed }), "utf-8");

        const migrated = new ChatHistoryStore().list(project);

        expect(migrated).toHaveLength(3);
        expect(migrated[0]).toMatchObject({ sender: "user", content: "legacy first" });
        expect(migrated[1]).toEqual({
            id: "canonical-1",
            content: "already canonical",
            sender: "assistant",
            timestamp: 50,
        });
        expect(migrated[2]).toMatchObject({ sender: "user", content: "legacy second" });
    });

    it("generates stable legacy ids during migration", () => {
        const message = fromLegacyChatMessage({ role: "user", content: "x" }, 3, 1000);
        expect(message).toMatchObject({
            id: "legacy-3-user",
            sender: "user",
            content: "x",
            timestamp: 1003,
        });
    });

    it("migrates legacy top-level array files to wrapped canonical format", async () => {
        const project = await makeProject();
        const legacy = [
            { role: "user", content: "from array root" },
            { role: "assistant", content: "reply" },
        ];
        await fs.writeFile(historyFile(project), JSON.stringify(legacy), "utf-8");

        const migrated = new ChatHistoryStore().list(project);

        expect(migrated).toHaveLength(2);
        expect(migrated[0]).toMatchObject({ sender: "user", content: "from array root" });

        const onDisk = JSON.parse(await fs.readFile(historyFile(project), "utf-8")) as {
            messages: Array<{ sender: string; role?: string }>;
        };
        expect(Array.isArray(onDisk.messages)).toBe(true);
        expect(
            onDisk.messages.every((message) => "sender" in message && !("role" in message)),
        ).toBe(true);
    });

    it("wraps canonical top-level array files without altering message content", async () => {
        const project = await makeProject();
        const canonical = [
            {
                id: "root-1",
                content: "already wrapped later",
                sender: "user",
                timestamp: 99,
            },
        ];
        await fs.writeFile(historyFile(project), JSON.stringify(canonical), "utf-8");

        expect(new ChatHistoryStore().list(project)).toEqual(canonical);

        const onDisk = JSON.parse(await fs.readFile(historyFile(project), "utf-8")) as {
            messages: typeof canonical;
        };
        expect(onDisk).toEqual({ messages: canonical });
    });
});
