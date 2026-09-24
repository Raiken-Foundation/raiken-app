import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberAuthedEntry } from "../agent/graph/nodes/auth-entry";
import { AgentMemory } from "../agent/memory";

/**
 * The remembered authenticated entry URL poisons every future run when it is
 * not a real app page — about:blank is the canonical failure (a browser
 * opened but never navigated still "captures" it), and identity-provider
 * hosts are the other classic. The guard must reject both.
 */
describe("authenticated entry memory guard", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-entry-")));
        AgentMemory.clearInstances();
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("never remembers about:blank or non-http URLs", () => {
        const memory = AgentMemory.getInstance(projectPath);
        rememberAuthedEntry(projectPath, "about:blank");
        rememberAuthedEntry(projectPath, "data:text/html,<h1>hi</h1>");
        rememberAuthedEntry(projectPath, "file:///tmp/app/index.html");
        expect(memory.getPreference("authenticated_entry_url")).toBeNull();
    });

    it("remembers a real content route", () => {
        const memory = AgentMemory.getInstance(projectPath);
        rememberAuthedEntry(projectPath, "http://localhost:5173/projects");
        expect(memory.getPreference("authenticated_entry_url")).toBe(
            "http://localhost:5173/projects",
        );
    });

    it("rejects login-shaped routes and identity-provider hosts", () => {
        const memory = AgentMemory.getInstance(projectPath);
        rememberAuthedEntry(projectPath, "http://localhost:5173/login");
        rememberAuthedEntry(projectPath, "http://accounts.example.com/dashboard");
        expect(memory.getPreference("authenticated_entry_url")).toBeNull();
    });
});
