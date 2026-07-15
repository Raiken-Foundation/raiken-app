/**
 * createRepairNode drives the auto-repair loop. Two failure modes matter most:
 *  - No-progress: if the AI keeps returning the same code back (no actual
 *    fix), the loop must stop immediately instead of burning through
 *    `maxRetries` on guesses that are provably not changing anything.
 *  - Truncation: the full test file must reach the prompt, not just the
 *    first ~100 lines — otherwise the model is repairing blind past that
 *    point and can corrupt the file with an invented rewrite of the tail.
 */
import { describe, expect, it, vi } from "vitest";
import { createRepairNode } from "../agent/graph/nodes/repair";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";
import type { TestRunResult } from "../testing/runner";

const FAILING_RESULT: TestRunResult[] = [
    {
        testFile: "e2e/login.spec.ts",
        testName: "signs in",
        status: "failed",
        duration: 500,
        error: { message: "Timed out waiting for selector", selector: "#missing" },
    },
];

function baseState(overrides: Partial<GraphStateType> = {}): GraphStateType {
    return {
        testRunResult: FAILING_RESULT,
        repairAttempts: 0,
        savedTestPath: null,
        testDraft: "import { test } from '@playwright/test';\ntest('signs in', async () => {});\n",
        lastRepairedCode: null,
        ...overrides,
    } as GraphStateType;
}

function makeDeps(invokeContent: string, overrides: Partial<AgentNodeDeps> = {}) {
    const invoke = vi.fn(async () => ({ content: invokeContent }));
    const deps = {
        callTool: vi.fn(async () => ({ success: true, message: "saved" })),
        gatherContext: vi.fn(),
        // No raiken.config.json here, so loadAutoCorrectConfig falls back to
        // its defaults (autoCorrect: "suggest", maxRetries: 2).
        projectPath: "/tmp/raiken-repair-node-spec-nonexistent",
        model: { invoke },
        ...overrides,
    } as unknown as AgentNodeDeps;
    return { deps, invoke };
}

describe("createRepairNode — no-progress guard", () => {
    it("stops immediately when the AI returns the test unchanged from the current file", async () => {
        const testDraft = baseState().testDraft as string;
        const { deps } = makeDeps(`\`\`\`typescript\n${testDraft}\`\`\``);
        const node = createRepairNode(deps);

        const result = await node(baseState());

        expect(result.shouldPause).toBe(true);
        expect(result.summary).toMatch(/unchanged from the current file/i);
        expect(result.summary).toMatch(/isn't converging/i);
    });

    it("stops when the AI's fix matches its own previous attempt (oscillating, not converging)", async () => {
        const previousAttempt =
            "import { test } from '@playwright/test';\ntest('signs in', async () => { /* attempt 1 */ });\n";
        const { deps } = makeDeps(`\`\`\`typescript\n${previousAttempt}\`\`\``);
        const node = createRepairNode(deps);

        const result = await node(
            baseState({ repairAttempts: 1, lastRepairedCode: previousAttempt }),
        );

        expect(result.shouldPause).toBe(true);
        expect(result.summary).toMatch(/unchanged from.*its previous attempt/i);
    });

    it("proceeds normally and records the new code when the AI makes real progress", async () => {
        const fixedCode =
            "import { test } from '@playwright/test';\ntest('signs in', async () => { /* actually fixed */ });";
        const { deps } = makeDeps(`\`\`\`typescript\n${fixedCode}\n\`\`\``);
        const node = createRepairNode(deps);

        const result = await node(baseState());

        expect(result.testDraft).toBe(fixedCode);
        expect(result.lastRepairedCode).toBe(fixedCode);
        expect(result.summary).toBeUndefined();
        expect(result.shouldPause).toBe(true); // "suggest" mode always pauses for review
        expect(result.awaitUserMessage).toMatch(/repair suggestion/i);
    });
});

describe("createRepairNode — full-file context in the repair prompt", () => {
    it("sends the whole test file to the model instead of truncating at 4000 chars", async () => {
        // Pad the file well past the old hard 4000-char cutoff.
        const filler = "// padding line to inflate file size beyond 4000 chars\n".repeat(150);
        const longTestDraft = `import { test } from '@playwright/test';\n${filler}test('signs in', async () => {});\n`;
        expect(longTestDraft.length).toBeGreaterThan(4000);

        const fixedCode =
            "import { test } from '@playwright/test';\ntest('signs in', async () => { /* fixed */ });\n";
        const { deps, invoke } = makeDeps(`\`\`\`typescript\n${fixedCode}\`\`\``);
        const node = createRepairNode(deps);

        await node(baseState({ testDraft: longTestDraft }));

        expect(invoke).toHaveBeenCalledTimes(1);
        const [messages] = invoke.mock.calls[0] as unknown as [Array<{ content: string }>];
        const systemPromptText = messages[0].content;
        // The tail of the file (well past the old 4000-char cutoff) must be present.
        expect(systemPromptText).toContain("test('signs in', async () => {});");
        expect(systemPromptText).not.toContain("[TRUNCATED");
    });

    it("truncates with a visible marker only for pathologically large files", async () => {
        const filler = "x".repeat(25_000);
        const hugeTestDraft = `import { test } from '@playwright/test';\n// ${filler}\ntest('signs in', async () => {});\n`;

        const fixedCode =
            "import { test } from '@playwright/test';\ntest('signs in', async () => { /* fixed */ });\n";
        const { deps, invoke } = makeDeps(`\`\`\`typescript\n${fixedCode}\`\`\``);
        const node = createRepairNode(deps);

        await node(baseState({ testDraft: hugeTestDraft }));

        const [messages] = invoke.mock.calls[0] as unknown as [Array<{ content: string }>];
        expect(messages[0].content).toContain("[TRUNCATED");
    });
});
