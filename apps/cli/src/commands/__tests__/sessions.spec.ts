/**
 * `raiken sessions` — lists saved agent sessions (one-shot runs; see `raiken -p`).
 * Runs the command against a temp project's `.raiken/sessions/` fixtures.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withThrowExit } from "../../cli/exit";
import { saveSession } from "../../cli/sessions";

const { sessionsCommand } = await import("../sessions");

let projectPath: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-sessions-"));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "cwd").mockReturnValue(projectPath);
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
});

function stdoutText(): string {
    return stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
}

function logText(): string {
    return logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("sessionsCommand", () => {
    it("reports when no sessions exist", async () => {
        const code = await withThrowExit(() => sessionsCommand({}));
        expect(code).toBe(0);
        expect(logText()).toContain("No saved sessions");
        expect(logText()).not.toContain("resume");
    });

    it("lists saved sessions newest first with counts and previews", async () => {
        saveSession(projectPath, "login flow", [{ role: "user", content: "test the login page" }]);
        // Force an older timestamp on the first snapshot.
        const older = path.join(projectPath, ".raiken", "sessions", "login-flow.json");
        const raw = JSON.parse(fs.readFileSync(older, "utf-8")) as { updatedAt: number };
        raw.updatedAt = Date.now() - 60_000;
        fs.writeFileSync(older, JSON.stringify(raw));

        saveSession(projectPath, "checkout", [{ role: "user", content: "cover the cart" }]);

        const code = await withThrowExit(() => sessionsCommand({}));
        expect(code).toBe(0);
        const text = logText();
        expect(text.indexOf("checkout")).toBeLessThan(text.indexOf("login flow"));
        expect(text).toContain("1 msgs");
        expect(text).not.toContain("resume");
    });

    it("emits machine-readable JSON", async () => {
        saveSession(projectPath, "login flow", [{ role: "user", content: "test the login page" }]);
        const code = await withThrowExit(() => sessionsCommand({ json: true }));
        expect(code).toBe(0);
        const parsed = JSON.parse(stdoutText()) as {
            sessions: Array<{ name: string; messages: number; preview: string }>;
        };
        expect(parsed.sessions).toHaveLength(1);
        expect(parsed.sessions[0]?.name).toBe("login flow");
        expect(parsed.sessions[0]?.messages).toBe(1);
        expect(parsed.sessions[0]?.preview).toContain("test the login page");
    });
});
