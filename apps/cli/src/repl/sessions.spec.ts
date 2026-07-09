import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InputQueue } from "./queue";
import {
    listSessions,
    loadLiveHistory,
    previewMessage,
    resolveResumeTarget,
    saveLiveHistory,
    saveSession,
} from "./sessions";

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
});
