/**
 * `missingAiKeyMessage` — the fail-fast guard that makes `raiken repair` and
 * `raiken test --fix` exit 3 (config/auth) instead of 1 when the AI provider
 * has no key, matching the one-shot path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTests = vi.fn(async () => ({ success: true }));

vi.mock("@raiken/core", async (importActual) => {
    const actual = await importActual<typeof import("@raiken/core")>();
    return {
        ...actual,
        createProjectApplication: vi.fn(() => ({
            testing: {
                listTestFiles: vi.fn(async () => ({
                    files: [{ path: "tests/x.spec.ts", status: "broken" }],
                })),
                runTests,
            },
        })),
    };
});

const {
    missingAiKeyMessage,
    repairCommand,
    isAttemptOscillation,
    restampUnverifiedMarker,
    droppedProvenSelectors,
    withRepairDeadline,
    RepairDeadlineExceededError,
} = await import("../repair");
const { withThrowExit } = await import("../../repl/exit");

const AI_ENV_VARS = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "TOGETHER_API_KEY",
    "PERPLEXITY_API_KEY",
    "AI_API_KEY",
];

describe("missingAiKeyMessage", () => {
    let projectPath: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-repair-key-"));
        for (const name of AI_ENV_VARS) {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        }
    });

    afterEach(() => {
        for (const name of AI_ENV_VARS) {
            if (savedEnv[name] === undefined) delete process.env[name];
            else process.env[name] = savedEnv[name];
        }
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("returns the provider-specific message when no key is configured", () => {
        const message = missingAiKeyMessage(projectPath);
        expect(message).toContain("OpenRouter");
        expect(message).toContain("OPENROUTER_API_KEY");
    });

    it("returns null when the key comes from the environment", () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-testkey123";
        expect(missingAiKeyMessage(projectPath)).toBeNull();
    });

    it("returns null for a keyless provider (Ollama)", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "ollama" } }),
        );
        expect(missingAiKeyMessage(projectPath)).toBeNull();
    });

    it("returns null when the key is stored in config", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "openrouter", apiKey: "sk-or-v1-testkey123" } }),
        );
        expect(missingAiKeyMessage(projectPath)).toBeNull();
    });
});

describe("repairCommand fail-fast order", () => {
    let projectPath: string;
    let prevCwd: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-repair-order-"));
        prevCwd = process.cwd();
        process.chdir(projectPath);
        runTests.mockClear();
        for (const name of AI_ENV_VARS) {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        }
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        process.chdir(prevCwd);
        vi.restoreAllMocks();
        for (const name of AI_ENV_VARS) {
            if (savedEnv[name] === undefined) delete process.env[name];
            else process.env[name] = savedEnv[name];
        }
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("exits 3 without running the spec when the API key is missing", async () => {
        const code = await withThrowExit(() => repairCommand(undefined, {}));
        expect(code).toBe(3);
        expect(runTests).not.toHaveBeenCalled();
    });

    it("runs the spec first when a key is configured", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-testkey123";
        const code = await withThrowExit(() => repairCommand(undefined, {}));
        expect(code).toBe(0);
        expect(runTests).toHaveBeenCalledOnce();
    });
});

describe("isAttemptOscillation", () => {
    const A = "test('a', async ({ page }) => { await page.goto('/'); });\n";
    const B = "test('b', async ({ page }) => { await page.goto('/b'); });\n";

    it("detects a fix that reverts the previous attempt's change (A→B→A)", () => {
        // attempt N-1 started from A; attempt N returns A again.
        expect(isAttemptOscillation(A, A)).toBe(true);
        expect(isAttemptOscillation(A, B)).toBe(false);
    });

    it("never fires on the first attempt", () => {
        expect(isAttemptOscillation(undefined, A)).toBe(false);
    });

    it("ignores whitespace differences", () => {
        expect(isAttemptOscillation(`${A}\n`, `  ${A}`)).toBe(true);
    });
});

describe("restampUnverifiedMarker", () => {
    const marker = "@raiken-unverified";
    const original = `// ${marker} — drafted by raiken cover with unverified steps.\n${"import { test } from '@playwright/test';"}`;
    const fixed = "import { test } from '@playwright/test';";

    it("leaves a fix alone when the original never carried the marker", () => {
        const result = restampUnverifiedMarker("import { test } from '@playwright/test';", fixed);
        expect(result.restamped).toBe(false);
        expect(result.code).toBe(fixed);
    });

    it("leaves a fix alone when it keeps the marker", () => {
        const result = restampUnverifiedMarker(original, `${original}\n`);
        expect(result.restamped).toBe(false);
        expect(result.code).toBe(`${original}\n`);
    });

    it("re-stamps the marker when the AI draft dropped it", () => {
        const result = restampUnverifiedMarker(original, fixed);
        expect(result.restamped).toBe(true);
        expect(result.code).toContain(marker);
        expect(result.code.endsWith(fixed)).toBe(true);
        expect(result.code).toMatch(/^\/\/ @raiken-unverified/);
    });
});

describe("droppedProvenSelectors", () => {
    const proven = [
        {
            locator: "getByRole('link', { name: 'Tasks' })",
            value: "Tasks",
            alternatives: ["getByTestId('nav-tasks')", "getByTestId('recent-activity-all')"],
        },
    ];

    it("accepts a fix that keeps the proven literal", () => {
        expect(
            droppedProvenSelectors("await page.getByRole('link', { name: 'Tasks' }).click();", proven),
        ).toEqual([]);
    });

    it("accepts a fix that switches to a suggested aka test id", () => {
        expect(
            droppedProvenSelectors("await page.getByTestId('nav-tasks').click();", proven),
        ).toEqual([]);
    });

    it("accepts an aka test id written with the project's double-quote style", () => {
        // Playwright prints `aka getByTestId('nav-tasks')`; a biome config with
        // double quotes makes the fix write getByTestId("nav-tasks"). Quote
        // style must not count as dropping the selector.
        expect(
            droppedProvenSelectors('await page.getByTestId("nav-tasks").click();', proven),
        ).toEqual([]);
    });

    it("flags a fix that replaces the proven element with an invented locator", () => {
        expect(
            droppedProvenSelectors("await page.getByTestId('tasks-panel').click();", proven),
        ).toEqual(["Tasks"]);
    });
});

describe("withRepairDeadline", () => {
    it("resolves with elapsed time when the call finishes first", async () => {
        const timed = await withRepairDeadline("AI fix", 500, async () => "ok");
        expect(timed.result).toBe("ok");
        expect(timed.elapsedMs).toBeLessThan(500);
    });

    it("rejects with a distinct error when the deadline fires", async () => {
        await expect(
            withRepairDeadline("verify run", 40, () => new Promise(() => {})),
        ).rejects.toThrow(/verify run.*deadline/i);
    });

    it("aborts the underlying call so a hung request is actually cancelled", async () => {
        let seen: AbortSignal | undefined;
        await expect(
            withRepairDeadline("AI fix", 40, (signal) => {
                seen = signal;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                });
            }),
        ).rejects.toBeInstanceOf(RepairDeadlineExceededError);
        expect(seen?.aborted).toBe(true);
    });

    it("does not reject a fast call after the deadline timer was cleared", async () => {
        const timed = await withRepairDeadline("AI fix", 500, async () => "ok");
        // The clearTimeout in finally means no stray rejection after resolve.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(timed.result).toBe("ok");
    });
});
