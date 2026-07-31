import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatHistoryStore } from "@raiken/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputQueue } from "../queue";
import {
    clearConversation,
    listSessions,
    loadLiveHistory,
    previewMessage,
    resolveResumeTarget,
    saveLiveHistory,
    saveSession,
} from "../sessions";

describe("InputQueue", () => {
    it("enqueues and drains in order", () => {
        const q = new InputQueue();
        expect(q.enqueue("first")).toBe(1);
        expect(q.enqueue("second")).toBe(2);
        expect(q.enqueue("  ")).toBe(2);
        expect(q.dequeue()).toBe("first");
        expect(q.dequeue()).toBe("second");
        expect(q.dequeue()).toBeUndefined();
    });
});

describe("sessions", () => {
    let tmp: string;

    afterEach(() => {
        if (tmp && fs.existsSync(tmp)) {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    const project = () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-sess-"));
        return tmp;
    };

    it("saves, lists, and resumes named sessions", () => {
        const root = project();
        const messages = [
            { role: "user", content: "test the login flow" },
            { role: "assistant", content: "Drafted a spec." },
        ];
        const snap = saveSession(root, "Login Flow", messages, "ask");
        expect(snap.id).toBe("login-flow");
        expect(listSessions(root)).toHaveLength(1);

        const target = resolveResumeTarget(root, "login");
        expect(target.session?.id).toBe("login-flow");
        expect(target.messages).toHaveLength(2);
        expect(previewMessage(target.messages)).toContain("login");
    });

    it("falls back to live chat history", () => {
        const root = project();
        saveLiveHistory(root, [{ role: "user", content: "hello from live" }]);
        expect(loadLiveHistory(root)).toHaveLength(1);
        const target = resolveResumeTarget(root);
        expect(target.label).toBe("last chat");
        expect(target.messages[0]?.content).toBe("hello from live");
    });

    it("prefers latest snapshot over live history", () => {
        const root = project();
        saveLiveHistory(root, [{ role: "user", content: "live" }]);
        saveSession(root, "named", [{ role: "user", content: "from snapshot" }]);
        const target = resolveResumeTarget(root);
        expect(target.label).toBe("named");
        expect(target.messages[0]?.content).toBe("from snapshot");
    });

    it("reads canonical dashboard history through loadLiveHistory", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            {
                id: "dash",
                content: "from dashboard",
                sender: "user",
                timestamp: 42,
            },
        ]);
        expect(loadLiveHistory(root)).toEqual([
            { role: "user", content: "from dashboard", id: "dash", timestamp: 42 },
        ]);
    });

    it("writes canonical live history that dashboard can read", () => {
        const root = project();
        saveLiveHistory(root, [
            { role: "user", content: "repl message" },
            { role: "assistant", content: "repl reply" },
        ]);
        const canonical = chatHistoryStore.list(root);
        expect(canonical).toHaveLength(2);
        expect(canonical[0]?.sender).toBe("user");
        expect(canonical[1]?.sender).toBe("assistant");
        expect(canonical.every((message) => typeof message.id === "string")).toBe(true);
    });

    it("preserves dashboard message metadata when REPL re-saves unchanged history", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            {
                id: "dash-keep",
                content: "from dashboard",
                sender: "user",
                timestamp: 4242,
                fileMentions: ["src/app.tsx"],
            },
        ]);
        saveLiveHistory(root, [{ role: "user", content: "from dashboard" }]);
        expect(chatHistoryStore.list(root)[0]).toEqual({
            id: "dash-keep",
            content: "from dashboard",
            sender: "user",
            timestamp: 4242,
            fileMentions: ["src/app.tsx"],
        });
    });

    it("preserves metadata when prefix messages are removed before save", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            { id: "drop-me", content: "first", sender: "user", timestamp: 1 },
            {
                id: "keep-b",
                content: "second",
                sender: "assistant",
                timestamp: 2,
                fileMentions: ["b.ts"],
            },
            { id: "keep-c", content: "third", sender: "user", timestamp: 3 },
        ]);
        const loaded = loadLiveHistory(root);
        saveLiveHistory(root, loaded.slice(1));
        expect(chatHistoryStore.list(root)).toEqual([
            {
                id: "keep-b",
                content: "second",
                sender: "assistant",
                timestamp: 2,
                fileMentions: ["b.ts"],
            },
            { id: "keep-c", content: "third", sender: "user", timestamp: 3 },
        ]);
    });

    it("matches stable ids when REPL history carries explicit canonical metadata", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            { id: "a", content: "one", sender: "user", timestamp: 10 },
            { id: "b", content: "two", sender: "assistant", timestamp: 20 },
        ]);
        saveLiveHistory(root, [
            { role: "assistant", content: "two", id: "b", timestamp: 20 },
            { role: "user", content: "three" },
        ]);
        const canonical = chatHistoryStore.list(root);
        expect(canonical[0]?.id).toBe("b");
        expect(canonical[1]?.content).toBe("three");
        expect(canonical[1]?.id).toMatch(/^legacy-/);
    });

    it("preserves messages appended by the dashboard while the REPL is open", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            { id: "initial", content: "before", sender: "user", timestamp: 10 },
        ]);
        const replHistory = loadLiveHistory(root);
        const knownIds = new Set(
            replHistory.flatMap((message) => (message.id ? [message.id] : [])),
        );

        chatHistoryStore.append(root, {
            id: "dashboard-new",
            content: "concurrent dashboard reply",
            sender: "assistant",
            timestamp: 20,
        });
        replHistory.push({ role: "user", content: "new REPL request" });
        saveLiveHistory(root, replHistory, knownIds);

        expect(chatHistoryStore.list(root).map((message) => message.id)).toEqual([
            "initial",
            "dashboard-new",
            expect.stringMatching(/^legacy-/),
        ]);
    });

    it("does not resurrect a known suffix removed by the REPL", () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            { id: "keep", content: "keep", sender: "user", timestamp: 10 },
            { id: "remove", content: "remove", sender: "assistant", timestamp: 20 },
        ]);
        const loaded = loadLiveHistory(root);
        const knownIds = new Set(loaded.flatMap((message) => (message.id ? [message.id] : [])));

        saveLiveHistory(root, loaded.slice(0, 1), knownIds);

        expect(chatHistoryStore.list(root).map((message) => message.id)).toEqual(["keep"]);
    });

    it("clearConversation clears disk via fallback when tRPC is unavailable", async () => {
        const root = project();
        chatHistoryStore.replaceAll(root, [
            { id: "x", content: "hi", sender: "user", timestamp: 1 },
        ]);
        await clearConversation(root, {
            clearChatMessages: vi.fn().mockRejectedValue(new Error("offline")),
        });
        expect(chatHistoryStore.list(root)).toEqual([]);
    });
});
