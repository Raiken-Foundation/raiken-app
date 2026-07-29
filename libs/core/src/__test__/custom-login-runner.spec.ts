import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
    spawn: spawnMock,
}));

import { buildCustomLoginSpec, runCustomLoginScript } from "../browser/custom-login-runner";

describe("custom login runner", () => {
    let projectPath: string;

    beforeEach(() => {
        spawnMock.mockReset();
        projectPath = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), "raiken-custom-login-")),
        );
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("builds a setup spec that passes credentials without embedding values", () => {
        const source = buildCustomLoginSpec({
            scriptImport: "./login.ts",
            url: "https://app.example.com/login",
            timeoutMs: 45000,
        });

        expect(source).toContain('import login from "./login.ts"');
        expect(source).toContain("process.env.RAIKEN_AUTH_USERNAME");
        expect(source).toContain('page.goto("https://app.example.com/login"');
        expect(source).toContain("context.storageState");
    });

    it("runs the configured script in Playwright testDir and atomically saves state", async () => {
        fs.mkdirSync(path.join(projectPath, "tests", "auth"), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "tests", "auth", "login.ts"),
            "export default async () => {};",
        );
        fs.writeFileSync(
            path.join(projectPath, "playwright.config.ts"),
            'export default { testDir: "./pw-tests" };',
        );
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    customLoginScript: "tests/auth/login.ts",
                    storageStatePath: "tests/.auth/user.json",
                    credentials: {
                        usernameEnv: "TEST_LOGIN_USER",
                        passwordEnv: "TEST_LOGIN_PASSWORD",
                    },
                },
            }),
        );

        const previousUser = process.env["TEST_LOGIN_USER"];
        const previousPassword = process.env["TEST_LOGIN_PASSWORD"];
        process.env["TEST_LOGIN_USER"] = "configured-user";
        process.env["TEST_LOGIN_PASSWORD"] = "configured-password";
        let generatedSpec = "";
        let generatedSpecMode = 0;
        let childEnvironment: NodeJS.ProcessEnv = {};
        spawnMock.mockImplementation(
            (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
                const child = new EventEmitter() as EventEmitter & {
                    pid: number;
                    stdout: PassThrough;
                    stderr: PassThrough;
                };
                child.pid = 12345;
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                const specPath = fs
                    .readdirSync(path.join(projectPath, "pw-tests"))
                    .map((name) => path.join(projectPath, "pw-tests", name))
                    .find((candidate) => candidate.endsWith(".spec.ts"));
                generatedSpec = specPath ? fs.readFileSync(specPath, "utf-8") : "";
                generatedSpecMode = specPath ? fs.statSync(specPath).mode & 0o777 : 0;
                childEnvironment = options.env;
                fs.writeFileSync(
                    options.env["RAIKEN_AUTH_STATE_PATH"] as string,
                    JSON.stringify({
                        cookies: [{ name: "session", value: "ok", expires: -1 }],
                        origins: [],
                    }),
                );
                queueMicrotask(() => child.emit("close", 0));
                return child;
            },
        );

        try {
            const result = await runCustomLoginScript({ projectPath });

            expect(result.storageStatePath).toBe(
                path.join(projectPath, "tests", ".auth", "user.json"),
            );
            expect(result.cookies).toBe(1);
            expect(generatedSpec).toContain("../tests/auth/login.ts");
            expect(generatedSpec).not.toContain("configured-password");
            expect(generatedSpecMode).toBe(0o600);
            expect(childEnvironment["RAIKEN_AUTH_USERNAME"]).toBe("configured-user");
            expect(childEnvironment["RAIKEN_AUTH_PASSWORD"]).toBe("configured-password");
            expect(fs.statSync(result.storageStatePath).mode & 0o777).toBe(0o600);
            expect(fs.readdirSync(path.join(projectPath, "pw-tests"))).toEqual([]);
        } finally {
            if (previousUser === undefined) delete process.env["TEST_LOGIN_USER"];
            else process.env["TEST_LOGIN_USER"] = previousUser;
            if (previousPassword === undefined) delete process.env["TEST_LOGIN_PASSWORD"];
            else process.env["TEST_LOGIN_PASSWORD"] = previousPassword;
        }
    });

    it("rejects scripts outside the project", async () => {
        await expect(
            runCustomLoginScript({
                projectPath,
                scriptPath: "../outside.ts",
            }),
        ).rejects.toThrow("outside project");
        expect(spawnMock).not.toHaveBeenCalled();
    });
});
