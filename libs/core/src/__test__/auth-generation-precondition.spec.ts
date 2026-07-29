import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGenerateTestsNode } from "../agent/graph/nodes/context";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";
import type { AuthPrecondition } from "../agent/graph/utils";
import type { ContextData } from "../agent/prompts";

const GENERATED_TEST = `import { test, expect } from "@playwright/test";

test("auth scenario", async ({ page }) => {
    await page.goto("/auth/login");
    await expect(page).toHaveURL(/login/);
});
`;

describe("generation auth preconditions", () => {
    let projectPath: string;
    let capturedSystemPrompt: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-generation-"));
        const authDir = path.join(projectPath, ".raiken");
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(
            path.join(authDir, "auth-state.json"),
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    credentials: {
                        usernameEnv: "E2E_LOGIN_USER",
                        passwordEnv: "E2E_LOGIN_PASSWORD",
                    },
                },
            }),
        );
        capturedSystemPrompt = "";
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    async function generate(precondition: AuthPrecondition) {
        const context: ContextData = {
            files: [],
            projectType: "react",
            testDirectory: "tests",
            totalTokens: 0,
        };
        const model = {
            invoke: async (messages: Array<{ content: unknown }>) => {
                capturedSystemPrompt = String(messages[0]?.content ?? "");
                return { content: GENERATED_TEST };
            },
        };
        const deps = {
            projectPath,
            model,
            gatherContext: async () => context,
            buildSystemPrompt: () => "BASE SYSTEM PROMPT",
            getMemoryContext: () => undefined,
        } as unknown as AgentNodeDeps;
        const node = createGenerateTestsNode(deps);
        return node({
            userPrompt: "generate an MFA login test",
            authPrecondition: precondition,
            context,
            domSummary: "[LIVE DOM CONTEXT - /auth/login]",
            pageSummaries: [],
            conversationHistory: [],
        } as unknown as GraphStateType);
    }

    it("does not inject saved state into a login flow", async () => {
        const result = await generate("login_flow");

        expect(result.testDraft).not.toContain("storageState");
        expect(capturedSystemPrompt).toContain("exercise the real login flow");
        expect(capturedSystemPrompt).toContain("[AUTH FLOW]");
        expect(capturedSystemPrompt).toContain("process.env.E2E_LOGIN_USER");
        expect(capturedSystemPrompt).toContain("process.env.E2E_LOGIN_PASSWORD");
    });

    it("injects saved state into an authenticated feature test", async () => {
        const result = await generate("authenticated");

        expect(result.testDraft).toContain(
            'test.use({ storageState: ".raiken/auth-state.json" });',
        );
        expect(capturedSystemPrompt).toContain("a reusable signed-in session is available");
    });

    it("injects the configured storage-state path", async () => {
        const configuredPath = path.join(projectPath, "e2e", ".auth", "admin.json");
        fs.mkdirSync(path.dirname(configuredPath), { recursive: true });
        fs.copyFileSync(path.join(projectPath, ".raiken", "auth-state.json"), configuredPath);
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    storageStatePath: "e2e/.auth/admin.json",
                    credentials: {
                        usernameEnv: "E2E_LOGIN_USER",
                        passwordEnv: "E2E_LOGIN_PASSWORD",
                    },
                },
            }),
        );

        const result = await generate("authenticated");

        expect(result.testDraft).toContain('test.use({ storageState: "e2e/.auth/admin.json" });');
    });

    it("keeps an unauthenticated scenario logged out", async () => {
        const result = await generate("unauthenticated");

        expect(result.testDraft).not.toContain("storageState");
        expect(capturedSystemPrompt).toContain("start logged out");
        expect(capturedSystemPrompt).not.toContain("[AUTH FLOW]");
    });
});
