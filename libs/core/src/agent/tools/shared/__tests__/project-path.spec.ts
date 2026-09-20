import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safePath } from "../project-path";

/**
 * Pins the .raiken/ state-dir guardrail (review finding, agent-tools): the
 * model's readFile/listDirectory must never reach Raiken's own state —
 * auth-state.json holds live session cookies and the DBs hold crawl data,
 * and tool results are NOT covered by argument redaction.
 */
let projectPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-safe-path-"));
    fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
});

describe("safePath state-dir guardrail", () => {
    it("resolves normal project files", () => {
        // safePath canonicalizes through realpath (macOS /tmp → /private/tmp),
        // so compare against the realpath'd root.
        const realProject = fs.realpathSync(projectPath);
        expect(safePath(projectPath, "src/App.tsx")).toBe(
            path.join(realProject, "src", "App.tsx"),
        );
    });

    it("denies reads of .raiken internal state", () => {
        expect(() => safePath(projectPath, ".raiken/auth-state.json")).toThrow(
            /Raiken internal state is denied/,
        );
        expect(() => safePath(projectPath, ".raiken/raiken.db")).toThrow(
            /Raiken internal state is denied/,
        );
        expect(() => safePath(projectPath, ".raiken/traces/x.jsonl")).toThrow(
            /Raiken internal state is denied/,
        );
    });

    it("still denies traversal escapes", () => {
        expect(() => safePath(projectPath, "../outside.txt")).toThrow(/traversal denied/);
    });
});
