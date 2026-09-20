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
import { formatDOMContext } from "../browser/dom-capture";

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

function makeDeps(modelResponseContent: string | string[], overrides: Partial<AgentNodeDeps> = {}) {
    // An array supplies one response per generation pass, so a test can assert
    // what the node does when the first draft is rejected and regenerated.
    const responses = Array.isArray(modelResponseContent)
        ? [...modelResponseContent]
        : [modelResponseContent];
    const systemPrompts: string[] = [];
    const model = {
        invoke: vi.fn(async (messages: Array<{ content: unknown }>) => {
            systemPrompts.push(
                JSON.parse(String(messages.at(-1)?.content ?? "{}")).untrustedEvidence,
            );
            return { content: responses.length > 1 ? (responses.shift() as string) : responses[0] };
        }),
    };
    const deps = {
        gatherContext: vi.fn(async () => baseContext()),
        projectPath: "/tmp/project",
        model,
        buildSystemPrompt: () => "system prompt",
        getMemoryContext: () => undefined,
        ...overrides,
    } as unknown as AgentNodeDeps;
    return { deps, model, systemPrompts };
}

const VALID_TEST = `import { test, expect } from '@playwright/test';

test('signs in successfully', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('/dashboard');
});
`;

describe("createGenerateTestsNode — save-gate", () => {
    it("returns a machine-readable failure when the provider rejects generation", async () => {
        const { deps, model } = makeDeps("");
        model.invoke.mockRejectedValue(new Error("429 Too Many Requests"));
        const result = await createGenerateTestsNode(deps)(baseState({ context: baseContext() }));
        expect(result.failure).toContain("429");
        expect(result.testDraft).toBe("");
    });

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

/**
 * A draft whose locators contradict the captured DOM fails at runtime for a
 * reason that has nothing to do with the application, so it must never reach
 * `hitlSave`. The captured page below exposes the modal as `alertdialog`, which
 * is the exact shape of the bug this gate exists for.
 */
const DIALOG_DOM_SUMMARY = formatDOMContext({
    url: "http://127.0.0.1:5100/projects",
    title: "Projects",
    accessibilityTree: null,
    timestamp: 0,
    formFields: [],
    interactiveElements: [
        {
            tagName: "div",
            role: "alertdialog",
            name: "Delete project",
            suggestedSelectors: ["getByRole('alertdialog', { name: 'Delete project' })"],
        },
        {
            tagName: "button",
            role: "button",
            name: "Delete",
            suggestedSelectors: ["getByRole('button', { name: 'Delete' })"],
        },
    ],
});

function draftUsingRole(role: string): string {
    return `\`\`\`typescript
import { test, expect } from '@playwright/test';

test('deletes a project', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('${role}', { name: 'Delete project' })).toBeVisible();
});
\`\`\``;
}

describe("createGenerateTestsNode — grounding gate", () => {
    it("regenerates once with the violations fed back, then accepts the grounded draft", async () => {
        const { deps, model, systemPrompts } = makeDeps([
            draftUsingRole("dialog"),
            draftUsingRole("alertdialog"),
        ]);
        const node = createGenerateTestsNode(deps);
        const result = await node(
            baseState({ context: baseContext(), domSummary: DIALOG_DOM_SUMMARY }),
        );

        expect(model.invoke).toHaveBeenCalledTimes(2);
        expect(systemPrompts[1]).toContain("GROUNDING VIOLATIONS");
        expect(systemPrompts[1]).toContain("getByRole('alertdialog', { name: 'Delete project' })");

        expect(result.testDraft).toContain("getByRole('alertdialog', { name: 'Delete project' })");
        expect(result.summary).toBeUndefined();
    });

    it("rejects the draft when the same violation survives regeneration", async () => {
        const { deps, model } = makeDeps(draftUsingRole("dialog"));
        const node = createGenerateTestsNode(deps);
        const result = await node(
            baseState({ context: baseContext(), domSummary: DIALOG_DOM_SUMMARY }),
        );

        expect(model.invoke).toHaveBeenCalledTimes(2);
        expect(result.testDraft).toBe("");
        expect(result.summary).toMatch(/contradict the captured DOM/i);
        expect(result.summary).toContain("getByRole('dialog', { name: 'Delete project' })");
        expect(result.groundingViolations).toHaveLength(1);
        expect(result.groundingViolations?.[0].kind).toBe("role_mismatch");
    });

    it("keeps a draft whose only problem is an unconfirmable locator, and reports it", async () => {
        // A test id for a state that was never captured (an error banner that
        // only renders after a failed submit) can't be proven wrong. Blocking it
        // would refuse most negative-path tests, so it is surfaced instead.
        const draft = `\`\`\`typescript
import { test, expect } from '@playwright/test';

test('shows an error', async ({ page }) => {
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('delete-error')).toBeVisible();
});
\`\`\``;
        const { deps, model } = makeDeps(draft);
        const node = createGenerateTestsNode(deps);
        const result = await node(
            baseState({ context: baseContext(), domSummary: DIALOG_DOM_SUMMARY }),
        );

        expect(model.invoke).toHaveBeenCalledTimes(2);
        expect(result.testDraft).toContain("getByTestId('delete-error')");
        expect(result.summary).toBeUndefined();
        expect(result.groundingViolations?.map((v) => v.kind)).toEqual(["unknown_test_id"]);
    });

    it("does not regenerate when the first draft is already grounded", async () => {
        const { deps, model } = makeDeps(draftUsingRole("alertdialog"));
        const node = createGenerateTestsNode(deps);
        const result = await node(
            baseState({ context: baseContext(), domSummary: DIALOG_DOM_SUMMARY }),
        );

        expect(model.invoke).toHaveBeenCalledTimes(1);
        expect(result.testDraft).toContain("alertdialog");
        expect(result.groundingViolations).toEqual([]);
    });
});
