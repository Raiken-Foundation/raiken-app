import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_EXIT } from "../../errors";
import { withThrowExit } from "../../repl/exit";

const mocks = vi.hoisted(() => ({
    loadAuthConfig: vi.fn(),
    runCustomLoginScript: vi.fn(),
    resolveHandoffBlockers: vi.fn(() => 0),
    spinner: {
        start: vi.fn(),
        succeed: vi.fn(),
        fail: vi.fn(),
        stop: vi.fn(),
        text: "",
    },
}));

vi.mock("@raiken/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@raiken/core")>();
    return {
        ...actual,
        acquireProjectOperation: vi.fn(),
        loadAuthConfig: mocks.loadAuthConfig,
        looksLikeLoginUrl: vi.fn(() => false),
        resolveHandoffBlockers: mocks.resolveHandoffBlockers,
        runCustomLoginScript: mocks.runCustomLoginScript,
    };
});

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
        projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cli-auth-")));
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
                storageStatePath: path.resolve(projectPath, ".raiken", "auth-state.json"),
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
                storageStatePath: path.resolve(projectPath, "e2e", ".auth", "admin.json"),
            }),
        );
    });

    it("rejects an invalid custom-script timeout", async () => {
        const code = await withThrowExit(() => authCommand({ timeout: "nope" }));
        expect(code).toBe(CLI_EXIT.USAGE);
        expect(mocks.runCustomLoginScript).not.toHaveBeenCalled();
    });

    it("lets --manual override a configured script", () => {
        expect(shouldRunCustomLogin({ manual: true }, "auth/login.ts")).toBe(false);
        expect(shouldRunCustomLogin({}, "auth/login.ts")).toBe(true);
    });
});

describe("authCommand --cookie import", () => {
    let projectPath: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cli-auth-")));
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectPath);
        mocks.loadAuthConfig.mockReturnValue({});
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function readImportedState() {
        const dest = path.join(projectPath, ".raiken", "auth-state.json");
        return JSON.parse(fs.readFileSync(dest, "utf8")) as {
            cookies: Array<{ name: string; value: string; domain: string; secure: boolean }>;
            origins: Array<{ origin: string }>;
        };
    }

    // Regression: the importer used to hardcode secure: true and a leading-dot
    // domain — fine on 127.0.0.1 (Chromium treats it as a secure context) but
    // silently dropped on every plain-http LAN/staging host.
    it("infers secure: false from an explicit http scheme", async () => {
        await authCommand({ cookie: "session=abc", domain: "http://staging.local:8080" });

        const state = readImportedState();
        expect(state.cookies).toHaveLength(1);
        expect(state.cookies[0].secure).toBe(false);
        // Multi-label name: domain cookie, port stripped.
        expect(state.cookies[0].domain).toBe(".staging.local");
    });

    it("keeps secure: true and a domain cookie for https URLs (path stripped)", async () => {
        await authCommand({ cookie: "session=abc", domain: "https://app.example.com/login" });

        const state = readImportedState();
        expect(state.cookies[0].secure).toBe(true);
        expect(state.cookies[0].domain).toBe(".app.example.com");
    });

    it("assumes https for bare hosts", async () => {
        await authCommand({ cookie: "session=abc", domain: "app.example.com" });

        const state = readImportedState();
        expect(state.cookies[0].secure).toBe(true);
        expect(state.cookies[0].domain).toBe(".app.example.com");
    });

    it("writes a host-only cookie for IP literals and keeps the port out of the domain", async () => {
        await authCommand({ cookie: "session=abc", domain: "http://127.0.0.1:8123" });

        const state = readImportedState();
        expect(state.cookies[0].secure).toBe(false);
        expect(state.cookies[0].domain).toBe("127.0.0.1");
    });

    it("writes a host-only cookie for localhost", async () => {
        await authCommand({ cookie: "session=abc", domain: "http://localhost:3000" });

        const state = readImportedState();
        expect(state.cookies[0].secure).toBe(false);
        expect(state.cookies[0].domain).toBe("localhost");
    });

    it("anchors --storage origins at the parsed scheme + host:port", async () => {
        await authCommand({ storage: ["token=xyz"], domain: "http://127.0.0.1:8123/app" });

        const state = readImportedState();
        expect(state.origins).toHaveLength(1);
        expect(state.origins[0].origin).toBe("http://127.0.0.1:8123");
    });

    it("rejects an unparseable --domain", async () => {
        const code = await withThrowExit(() =>
            authCommand({ cookie: "session=abc", domain: "http://" }),
        );
        expect(code).toBe(CLI_EXIT.USAGE);
    });
});
