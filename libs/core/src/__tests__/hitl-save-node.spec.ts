/**
 * The save node decides WHERE a draft lands. When the user had a spec open,
 * that file is the destination — and the approving surface has to be told so,
 * or its dedup guard writes `login-2.spec.ts` beside the file they asked to
 * update and the original stays broken.
 */
import { describe, expect, it, vi } from "vitest";
import { createHitlSaveNode } from "../agent/graph/nodes/hitl";
import type { CallTool } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";

const DRAFT = 'import { test } from "@playwright/test";\n\ntest("logs in", async () => {});';

function saveNode(callTool: CallTool) {
    return createHitlSaveNode({ callTool } as unknown as Parameters<typeof createHitlSaveNode>[0]);
}

function state(overrides: Partial<GraphStateType> = {}): GraphStateType {
    return { testDraft: DRAFT, testDirectory: "e2e", ...overrides } as GraphStateType;
}

describe("createHitlSaveNode", () => {
    it("marks the user's open spec as an overwrite target", async () => {
        const callTool: CallTool = vi.fn(async () => ({
            success: true,
            data: { path: "tests/e2e/login.spec.ts", saved: true },
            message: "saved",
        }));

        await saveNode(callTool)(state({ targetTestFile: "tests/e2e/login.spec.ts" }));

        expect(callTool).toHaveBeenCalledWith(
            "saveFile",
            expect.objectContaining({
                filePath: "tests/e2e/login.spec.ts",
                _overwriteTarget: true,
            }),
        );
    });

    it("does not mark a name derived from the draft", async () => {
        const callTool: CallTool = vi.fn(async () => ({
            success: true,
            data: { path: "e2e/logs-in.spec.ts", saved: true },
            message: "saved",
        }));

        await saveNode(callTool)(state({ userPrompt: "logs in" }));

        expect(callTool).toHaveBeenCalledWith(
            "saveFile",
            expect.objectContaining({ _overwriteTarget: false }),
        );
    });
});
