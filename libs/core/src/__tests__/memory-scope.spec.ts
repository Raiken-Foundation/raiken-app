/**
 * Run-scoped preferences (goal, pause reason, last exploration) must not look
 * like durable project knowledge in `raiken memory`, and must clear when a
 * task completes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemory, filterDurablePreferences, isRunScopedPreference } from "../agent/memory";

describe("agent memory scope", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-memory-scope-"));
        fs.mkdirSync(path.join(projectDir, ".raiken"), { recursive: true });
        AgentMemory.clearInstances();
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("classifies run/session keys separately from durable prefs", () => {
        expect(isRunScopedPreference("paused_reason")).toBe(true);
        expect(isRunScopedPreference("active_goal")).toBe(true);
        expect(isRunScopedPreference("next_tool")).toBe(true);
        expect(isRunScopedPreference("project_base_url")).toBe(false);
        expect(isRunScopedPreference("action_path:sign out")).toBe(false);
    });

    it("getDurablePreferences hides run state; clearGoalState wipes it", () => {
        const memory = AgentMemory.getInstance(projectDir);
        memory.initialize(false);
        memory.setPreference("project_base_url", "http://localhost:5199");
        memory.setPreference("paused_reason", "user_input");
        memory.setPreference("next_tool", "testGen");
        memory.setGoalState({
            activeGoal: "cover checkout",
            targetFeature: "cart",
            targetUrl: "/cart",
            missingContext: ["auth"],
            nextTool: "testGen",
        });
        memory.setActiveIntent("generateTests");

        expect(memory.getDurablePreferences()).toEqual({
            project_base_url: "http://localhost:5199",
        });
        expect(filterDurablePreferences(memory.getAllPreferences())).toEqual({
            project_base_url: "http://localhost:5199",
        });

        memory.clearGoalState();
        memory.setPreference("paused_reason", "");

        expect(memory.getPreference("active_goal")).toBe("");
        expect(memory.getPreference("active_intent")).toBe("");
        expect(memory.getPreference("next_tool")).toBe("");
        expect(memory.getPreference("project_base_url")).toBe("http://localhost:5199");
    });
});
