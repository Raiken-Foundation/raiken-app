import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAuthSession } from "../agent/graph/nodes/auth-entry";
import { ensureBrowserStarted, resolveBrowserAuthStatePath } from "../agent/tools";
import type { BrowserSession } from "../browser/session";

describe("browser auth preconditions", () => {
    let projectPath: string;
    let authStatePath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-precondition-"));
        projectPath = fs.realpathSync(projectPath);
        const authDir = path.join(projectPath, ".raiken");
        fs.mkdirSync(authDir, { recursive: true });
        authStatePath = path.join(authDir, "auth-state.json");
        fs.writeFileSync(
            authStatePath,
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("loads saved state for authenticated browser grounding", () => {
        expect(resolveBrowserAuthStatePath(projectPath, "authenticated")).toBe(authStatePath);
        expect(hasAuthSession(projectPath)).toBe(true);
    });

    it("loads only usable state from the configured path", () => {
        const configuredPath = path.join(projectPath, "e2e", ".auth", "user.json");
        fs.mkdirSync(path.dirname(configuredPath), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ auth: { storageStatePath: "e2e/.auth/user.json" } }),
        );
        fs.writeFileSync(
            configuredPath,
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );

        expect(resolveBrowserAuthStatePath(projectPath, "authenticated")).toBe(configuredPath);

        fs.writeFileSync(
            configuredPath,
            JSON.stringify({
                cookies: [
                    {
                        name: "session",
                        value: "stale",
                        expires: Math.floor(Date.now() / 1000) - 60,
                    },
                ],
                origins: [],
            }),
        );
        expect(resolveBrowserAuthStatePath(projectPath, "authenticated")).toBeUndefined();
        expect(hasAuthSession(projectPath)).toBe(false);
    });

    it.each([
        "unauthenticated",
        "login_flow",
    ] as const)("suppresses saved state for %s browser grounding", (precondition) => {
        expect(resolveBrowserAuthStatePath(projectPath, precondition)).toBeUndefined();
    });

    it("restarts an active browser when the goal auth precondition changes", async () => {
        let active = true;
        let closes = 0;
        const starts: Array<{ storageStatePath?: string }> = [];
        const session = {
            isActive: () => active,
            close: async () => {
                closes++;
                active = false;
            },
            start: async (options: { storageStatePath?: string }) => {
                starts.push(options);
                active = true;
            },
        } as unknown as BrowserSession;
        let precondition: "login_flow" | "authenticated" = "login_flow";

        await ensureBrowserStarted(session, projectPath, () => precondition);
        expect(closes).toBe(1);
        expect(starts[0]?.storageStatePath).toBeUndefined();

        await ensureBrowserStarted(session, projectPath, () => precondition);
        expect(closes).toBe(1);
        expect(starts).toHaveLength(1);

        precondition = "authenticated";
        await ensureBrowserStarted(session, projectPath, () => precondition);
        expect(closes).toBe(2);
        expect(starts[1]?.storageStatePath).toBe(authStatePath);
    });
});
