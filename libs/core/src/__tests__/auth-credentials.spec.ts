import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    authCredentialEnvGuidance,
    mapAuthCredentialsToFields,
    resolveAuthCredentials,
} from "../config/auth-credentials";

describe("auth credentials", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-credentials-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("resolves named environment variables ahead of literal compatibility values", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    credentials: {
                        username: "literal-user",
                        password: "literal-password",
                        usernameEnv: "E2E_LOGIN_USER",
                        passwordEnv: "E2E_LOGIN_PASSWORD",
                    },
                },
            }),
        );

        expect(
            resolveAuthCredentials(projectPath, {
                E2E_LOGIN_USER: "environment-user",
                E2E_LOGIN_PASSWORD: "environment-password",
            }),
        ).toEqual({
            username: "environment-user",
            password: "environment-password",
            usernameEnv: "E2E_LOGIN_USER",
            passwordEnv: "E2E_LOGIN_PASSWORD",
        });
    });

    it("maps configured values only to identity and password fields", () => {
        const mapped = mapAuthCredentialsToFields(
            [
                { key: "work_email", label: "Work email", type: "email" },
                { key: "password", label: "Password", type: "password" },
                { key: "security_code", label: "Security code", type: "text" },
            ],
            { username: "user@example.com", password: "secret" },
        );

        expect(mapped).toEqual({
            work_email: "user@example.com",
            password: "secret",
        });
    });

    it("names configured variables in guidance without exposing their values", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    credentials: {
                        usernameEnv: "E2E_USER",
                        passwordEnv: "E2E_PASSWORD",
                    },
                },
            }),
        );

        const guidance = authCredentialEnvGuidance(projectPath);
        expect(guidance).toContain("process.env.E2E_USER");
        expect(guidance).toContain("process.env.E2E_PASSWORD");
    });
});
