import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    loadAuthConfig: vi.fn(),
    runCustomLoginScript: vi.fn(),
    spinner: {
        start: vi.fn(),
        succeed: vi.fn(),
        fail: vi.fn(),
        stop: vi.fn(),
        text: "",
    },
}));

vi.mock("@raiken/core", () => ({
    acquireProjectOperation: vi.fn(),
    loadAuthConfig: mocks.loadAuthConfig,
    looksLikeLoginUrl: vi.fn(() => false),
    runCustomLoginScript: mocks.runCustomLoginScript,
}));

vi.mock("@raiken/shared", () => ({
    resolveAuthStorageStateDestination: (projectPath: string) => {
        try {
            const config = JSON.parse(
                fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8"),
            ) as { auth?: { storageStatePath?: string } };
            if (config.auth?.storageStatePath) {
                return path.resolve(projectPath, config.auth.storageStatePath);
            }
        } catch {
            // Fall through to the default.
        }
        return path.join(projectPath, ".raiken", "auth-state.json");
    },
}));

vi.mock("ora", () => ({
    default: vi.fn(() => {
        mocks.spinner.start.mockReturnValue(mocks.spinner);
        return mocks.spinner;
    }),
}));

import { authCommand, shouldRunCustomLogin } from "../auth";

describe("authCommand custom login", () => {
    let projectPath: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cli-auth-"));
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectPath);
        mocks.loadAuthConfig.mockReturnValue({ customLoginScript: "auth/login.ts" });
        mocks.runCustomLoginScript.mockResolvedValue({
            scriptPath: path.join(projectPath, "auth", "login.ts"),
            storageStatePath: path.join(projectPath, ".raiken", "auth-state.json"),
            cookies: 1,
            origins: 1,
        });
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("runs the configured script by default", async () => {
        await authCommand({});

        expect(mocks.runCustomLoginScript).toHaveBeenCalledWith(
            expect.objectContaining({
                projectPath,
                storageStatePath: path.join(projectPath, ".raiken", "auth-state.json"),
            }),
        );
        expect(mocks.spinner.succeed).toHaveBeenCalled();
    });

    it("passes explicit script controls to the runner", async () => {
        await authCommand({
            script: "auth/alternate.ts",
            url: "https://example.com/login",
            timeout: "45000",
            headed: true,
        });

        expect(mocks.runCustomLoginScript).toHaveBeenCalledWith(
            expect.objectContaining({
                scriptPath: "auth/alternate.ts",
                url: "https://example.com/login",
                timeoutMs: 45000,
                headed: true,
            }),
        );
    });

    it("saves scripted login state to the configured destination", async () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                auth: {
                    customLoginScript: "auth/login.ts",
                    storageStatePath: "e2e/.auth/admin.json",
                },
            }),
        );

        await authCommand({});

        expect(mocks.runCustomLoginScript).toHaveBeenCalledWith(
            expect.objectContaining({
                storageStatePath: path.join(projectPath, "e2e", ".auth", "admin.json"),
            }),
        );
    });

    it("rejects an invalid custom-script timeout", async () => {
        await expect(authCommand({ timeout: "nope" })).rejects.toThrow(
            "--timeout must be a positive number",
        );
        expect(mocks.runCustomLoginScript).not.toHaveBeenCalled();
    });

    it("lets --manual override a configured script", () => {
        expect(shouldRunCustomLogin({ manual: true }, "auth/login.ts")).toBe(false);
        expect(shouldRunCustomLogin({}, "auth/login.ts")).toBe(true);
    });
});
