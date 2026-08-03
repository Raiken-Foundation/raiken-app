import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCustomLoginScript } from "../custom-login-runner";

const projectPath = path.resolve(__dirname, "../../../../../tools/playground-tasks");
const statePath = path.join(projectPath, ".raiken", "auth-state.json");

describe("custom login runner integration", () => {
    let previousState: Buffer | null;
    let previousUser: string | undefined;
    let previousPassword: string | undefined;

    beforeAll(() => {
        previousState = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
        previousUser = process.env["RAIKEN_PLAYGROUND_AUTH_USER"];
        previousPassword = process.env["RAIKEN_PLAYGROUND_AUTH_PASSWORD"];
        process.env["RAIKEN_PLAYGROUND_AUTH_USER"] = "admin";
        process.env["RAIKEN_PLAYGROUND_AUTH_PASSWORD"] = "password";
    });

    afterAll(() => {
        if (previousState) {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, previousState);
        } else {
            fs.rmSync(statePath, { force: true });
        }
        if (previousUser === undefined) delete process.env["RAIKEN_PLAYGROUND_AUTH_USER"];
        else process.env["RAIKEN_PLAYGROUND_AUTH_USER"] = previousUser;
        if (previousPassword === undefined) delete process.env["RAIKEN_PLAYGROUND_AUTH_PASSWORD"];
        else process.env["RAIKEN_PLAYGROUND_AUTH_PASSWORD"] = previousPassword;
    });

    it("logs in through the fixture and saves reusable state", async () => {
        const result = await runCustomLoginScript({
            projectPath,
            timeoutMs: 90_000,
        });

        expect(result.cookies).toBeGreaterThan(0);
        expect(result.storageStatePath).toBe(statePath);
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
            cookies: Array<{ name: string }>;
        };
        expect(state.cookies.some((cookie) => cookie.name === "raiken-session")).toBe(true);
    });
});
