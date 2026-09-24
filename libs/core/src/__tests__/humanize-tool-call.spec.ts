/**
 * `humanizeToolCall` coverage test (Phase 8 of the close-partial-gaps plan).
 *
 * Asserts every tool `createAgentTools` exposes has a real, specific label —
 * not the generic `Running <name>...` fallback — so the activity trail never
 * silently regresses to a raw tool name when a new tool is added to
 * `agent/tools.ts` without a matching entry here. The fallback itself is
 * still exercised directly so it's covered too.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { humanizeToolCall } from "../agent/agent";
import { createAgentTools } from "../agent/tools";

describe("humanizeToolCall", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-humanize-"));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("gives every tool from createAgentTools a specific (non-fallback) label", () => {
        const tools = createAgentTools({ projectPath: testDir });
        const toolNames = Object.keys(tools);

        expect(toolNames.length).toBeGreaterThan(0);
        for (const name of toolNames) {
            const label = humanizeToolCall(name);
            expect(label).not.toBe(`Running ${name}...`);
            expect(label.length).toBeGreaterThan(0);
        }
    });

    it("falls back to a generic 'Running <name>...' label for an unknown tool", () => {
        expect(humanizeToolCall("someBrandNewTool")).toBe("Running someBrandNewTool...");
    });

    it("never returns null or an empty string", () => {
        for (const name of [
            ...Object.keys(createAgentTools({ projectPath: testDir })),
            "madeUpTool",
        ]) {
            const label = humanizeToolCall(name);
            expect(label).toBeTruthy();
        }
    });
});
