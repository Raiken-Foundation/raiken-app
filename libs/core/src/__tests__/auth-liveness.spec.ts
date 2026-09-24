/**
 * Live auth probe: storageState that "looks valid" but still lands on login.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemory } from "../agent/memory";
import {
    AUTH_LIVENESS_TTL_MS,
    authLivenessBlocks,
    clearAuthLivenessCache,
    probeAuthState,
} from "../config/auth-liveness";

describe("probeAuthState", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-live-"));
        fs.mkdirSync(path.join(projectDir, ".raiken"), { recursive: true });
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function writeState(cookies: object[]): void {
        fs.writeFileSync(
            path.join(projectDir, ".raiken", "auth-state.json"),
            JSON.stringify({
                cookies,
                origins: [{ origin: "http://localhost:3000", localStorage: [] }],
            }),
        );
    }

    it("reports no_state when nothing is on disk", async () => {
        const result = await probeAuthState({ projectPath: projectDir });
        expect(result.status).toBe("no_state");
        expect(authLivenessBlocks(result)).toBe(false);
    });

    it("reports file_unusable when cookies are expired", async () => {
        writeState([{ name: "session", value: "x", expires: 1 }]);
        const result = await probeAuthState({ projectPath: projectDir });
        expect(result.status).toBe("file_unusable");
        expect(authLivenessBlocks(result)).toBe(true);
        expect(result.message).toMatch(/raiken auth/);
    });

    it("marks stale when navigate lands on a login URL", async () => {
        writeState([{ name: "session", value: "active", expires: -1 }]);
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };\n`,
        );
        const result = await probeAuthState({
            projectPath: projectDir,
            navigate: async () => "http://localhost:3000/login",
        });
        expect(result.status).toBe("stale");
        expect(authLivenessBlocks(result)).toBe(true);
        expect(result.landedUrl).toContain("/login");
    });

    it("marks live when navigate stays on an app page", async () => {
        writeState([{ name: "session", value: "active", expires: -1 }]);
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };\n`,
        );
        const result = await probeAuthState({
            projectPath: projectDir,
            navigate: async () => "http://localhost:3000/dashboard",
        });
        expect(result.status).toBe("live");
        expect(authLivenessBlocks(result)).toBe(false);
    });

    it("reuses a cached live verdict without calling navigate again", async () => {
        writeState([{ name: "session", value: "active", expires: -1 }]);
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };\n`,
        );
        let calls = 0;
        const navigate = async () => {
            calls += 1;
            return "http://localhost:3000/dashboard";
        };
        await probeAuthState({ projectPath: projectDir, navigate });
        const second = await probeAuthState({ projectPath: projectDir, navigate });
        expect(calls).toBe(1);
        expect(second.fromCache).toBe(true);
        expect(second.status).toBe("live");
        expect(AUTH_LIVENESS_TTL_MS).toBeGreaterThan(0);
    });

    it("clearAuthLivenessCache forces a fresh probe", async () => {
        writeState([{ name: "session", value: "active", expires: -1 }]);
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };\n`,
        );
        let calls = 0;
        const navigate = async () => {
            calls += 1;
            return "http://localhost:3000/dashboard";
        };
        await probeAuthState({ projectPath: projectDir, navigate });
        clearAuthLivenessCache(projectDir);
        await probeAuthState({ projectPath: projectDir, navigate });
        expect(calls).toBe(2);
    });
});
