import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const graphInvoke = vi.hoisted(() => vi.fn());
vi.mock("../agent/graph/graph", () => ({ createAgentGraph: () => ({ invoke: graphInvoke }) }));

import { runOrchestrator } from "../orchestrator";

describe("agent terminal failure contract", () => {
    let project: string;
    afterEach(() => {
        if (project) fs.rmSync(project, { recursive: true, force: true });
    });
    it("propagates generation failures through the real agent and orchestrator", async () => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-outcome-"));
        fs.writeFileSync(
            path.join(project, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "ollama", model: "fixture" } }),
        );
        graphInvoke.mockResolvedValue({
            failure: "Test generation failed: 429 Too Many Requests",
            testDraft: "",
            summary: "Test generation failed",
        });
        const tools = vi.fn();
        const consume = async () => {
            for await (const _chunk of runOrchestrator({
                projectPath: project,
                userPrompt: "generate and run checkout tests",
                onToolCall: tools,
            })) {
                /* consume */
            }
        };
        await expect(consume()).rejects.toMatchObject({
            category: "external",
            message: expect.stringContaining("429"),
        });
        expect(tools.mock.calls.some(([name]) => name === "saveFile" || name === "runTest")).toBe(
            false,
        );
        // Failure must release the project lease; a second attempt gets the
        // same provider error, rather than becoming permanently busy.
        await expect(consume()).rejects.toMatchObject({ category: "external" });
    });
});
