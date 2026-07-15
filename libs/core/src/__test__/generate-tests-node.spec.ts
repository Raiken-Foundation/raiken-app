/**
 * createGenerateTestsNode must never hand a garbage draft downstream as if it
 * were a real test. `hitl.ts` only checks `if (!state.testDraft) return {}`,
 * so any truthy-but-broken string — a truncated stream, an empty reply, the
 * model answering with prose — would otherwise be written to disk and
 * (depending on autonomy settings) run unconditionally.
 */
import { describe, expect, it, vi } from "vitest";
import { createGenerateTestsNode } from "../agent/graph/nodes/context";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";
import type { ContextData } from "../agent/prompts";

function baseContext(): ContextData {
    return {
        files: [],
        projectType: "unknown",
        testDirectory: "e2e",
    } as unknown as ContextData;
}

function baseState(overrides: Partial<GraphStateType> = {}): GraphStateType {
    return {
        userPrompt: "test the login flow",
        domSummary: "Page: Login\n- getByRole('button', { name: 'Sign in' })",
        pageSummaries: [],
        fileContext: [],
        ...overrides,
    } as GraphStateType;
}

function makeDeps(modelResponseContent: string, overrides: Partial<AgentNodeDeps> = {}) {
    const model = { invoke: vi.fn(async () => ({ content: modelResponseContent })) };
    const deps = {
        gatherContext: vi.fn(async () => baseContext()),
        projectPath: "/tmp/project",
        model,
        buildSystemPrompt: () => "system prompt",
        getMemoryContext: () => undefined,
        ...overrides,
    } as unknown as AgentNodeDeps;
    return { deps, model };
}

const VALID_TEST = `import { test, expect } from '@playwright/test';

test('signs in successfully', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('/dashboard');
});
`;

describe("createGenerateTestsNode — save-gate", () => {
    it("accepts well-formed, non-empty Playwright test code", async () => {
        const { deps } = makeDeps(`\`\`\`typescript\n${VALID_TEST}\`\`\``);
        const node = createGenerateTestsNode(deps);
        const result = await node(baseState({ context: baseContext() }));

        expect(result.testDraft).toContain("test('signs in successfully'");
        expect(result.summary).toBeUndefined();
    });

    it("rejects an empty model response instead of returning a blank-but-truthy draft", async () => {
        const { deps } = makeDeps("");
        const node = createGenerateTestsNode(deps);
        const result = await node(baseState({ context: baseContext() }));

        expect(result.testDraft).toBe("");
        expect(result.summary).toMatch(/empty response/i);
    });

    it("rejects output with no Playwright test() call even when it parses as valid JS", async () => {
        // Syntactically valid JS/TS (just a comment) but not an actual test —
        // this must be caught by the test()-call check, not the parser.
        const { deps } = makeDeps(
            "// I need more information about the login flow before writing this test.",
        );
        const node = createGenerateTestsNode(deps);
        const result = await node(baseState({ context: baseContext() }));

        expect(result.testDraft).toBe("");
        expect(result.summary).toMatch(/no Playwright test\(\) call/i);
    });

    it("rejects code that doesn't parse as valid JS/TS (e.g. a stream cut off mid-token)", async () => {
        const truncated = `import { test, expect } from '@playwright/test';

test('signs in successfully', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: "Sign in`; // cut off mid string literal
        const { deps } = makeDeps(`\`\`\`typescript\n${truncated}\`\`\``);
        const node = createGenerateTestsNode(deps);
        const result = await node(baseState({ context: baseContext() }));

        expect(result.testDraft).toBe("");
        expect(result.summary).toMatch(/does not parse as valid/i);
    });
});
