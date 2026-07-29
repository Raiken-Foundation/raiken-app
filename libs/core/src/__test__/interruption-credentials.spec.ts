import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createResolveInterruptionNode } from "../agent/graph/nodes/interruptions";
import type { AgentNodeDeps } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";

const LOGIN_SUMMARY = `Page Title: Sign in
URL: https://example.test/login
INTERACTIVE ELEMENTS:
• textbox: "Username" [type=text]
  Selectors: input[name="username"]
• textbox: "Password" [type=password]
  Selectors: input[name="password"]
• button: "Sign in"
  Selectors: getByRole('button', { name: 'Sign in' })
`;

const DASHBOARD_SUMMARY = `Page Title: Dashboard
URL: https://example.test/dashboard
INTERACTIVE ELEMENTS:
• link: "Projects"
  Selectors: getByRole('link', { name: 'Projects' })
• link: "Settings"
  Selectors: getByRole('link', { name: 'Settings' })
• link: "Members"
  Selectors: getByRole('link', { name: 'Members' })
• link: "Tasks"
  Selectors: getByRole('link', { name: 'Tasks' })
`;

describe("configured interruption credentials", () => {
    let projectPath: string;
    let previousUser: string | undefined;
    let previousPassword: string | undefined;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-interruption-auth-"));
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    credentials: {
                        usernameEnv: "RAIKEN_TEST_LOGIN_USER",
                        passwordEnv: "RAIKEN_TEST_LOGIN_PASSWORD",
                    },
                },
            }),
        );
        previousUser = process.env["RAIKEN_TEST_LOGIN_USER"];
        previousPassword = process.env["RAIKEN_TEST_LOGIN_PASSWORD"];
        process.env["RAIKEN_TEST_LOGIN_USER"] = "configured-user";
        process.env["RAIKEN_TEST_LOGIN_PASSWORD"] = "configured-password";
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        if (previousUser === undefined) delete process.env["RAIKEN_TEST_LOGIN_USER"];
        else process.env["RAIKEN_TEST_LOGIN_USER"] = previousUser;
        if (previousPassword === undefined) delete process.env["RAIKEN_TEST_LOGIN_PASSWORD"];
        else process.env["RAIKEN_TEST_LOGIN_PASSWORD"] = previousPassword;
    });

    it("fills observed login fields from env vars without asking the model or user", async () => {
        let loggedIn = false;
        const calls: Array<{ name: string; args: unknown }> = [];
        const callTool = vi.fn(async (name: string, args: unknown) => {
            calls.push({ name, args });
            if (name === "captureCurrentPage") {
                return {
                    success: true,
                    data: {
                        url: loggedIn
                            ? "https://example.test/dashboard"
                            : "https://example.test/login",
                        summary: loggedIn ? DASHBOARD_SUMMARY : LOGIN_SUMMARY,
                    },
                    message: "captured",
                };
            }
            if (name === "clickElement") loggedIn = true;
            return { success: true, message: "ok" };
        });
        const model = {
            withStructuredOutput: vi.fn(() => ({
                invoke: vi.fn(() => {
                    throw new Error("credential presets should bypass the model");
                }),
            })),
        };
        const node = createResolveInterruptionNode({
            projectPath,
            callTool,
            model,
        } as unknown as AgentNodeDeps);

        const result = await node({
            userPrompt: "continue",
            conversationHistory: [],
            interruption: {
                type: "auth",
                message: "Sign in",
                requiresUser: false,
                requestedFields: [
                    {
                        key: "username",
                        label: "Username",
                        type: "text",
                        selectors: ['input[name="username"]'],
                    },
                    {
                        key: "password",
                        label: "Password",
                        type: "password",
                        selectors: ['input[name="password"]'],
                    },
                ],
                submitSelectors: ["getByRole('button', { name: 'Sign in' })"],
            },
        } as unknown as GraphStateType);

        expect(result.shouldPause).not.toBe(true);
        expect(model.withStructuredOutput).not.toHaveBeenCalled();
        expect(calls).toContainEqual({
            name: "fillInput",
            args: { selector: ['input[name="username"]'], value: "configured-user" },
        });
        expect(calls).toContainEqual({
            name: "fillInput",
            args: { selector: ['input[name="password"]'], value: "configured-password" },
        });
        expect(calls.some((call) => call.name === "saveAuthState")).toBe(true);
    });
});
