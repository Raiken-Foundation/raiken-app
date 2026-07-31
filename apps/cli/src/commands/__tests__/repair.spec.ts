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

const { missingAiKeyMessage, repairCommand } = await import("../repair");
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
