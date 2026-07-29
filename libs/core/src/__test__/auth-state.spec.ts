import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    describeAuthStateProblem,
    inspectAuthState,
    resolveAuthStorageStateDestination,
    resolveAuthStorageStatePath,
    resolveAuthStorageStateRelativePath,
    resolveUsableAuthStorageStatePath,
    writeValidatedAuthState,
} from "../config/auth-state";
import { PathContainmentError } from "../config/store";

describe("auth storage state", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-state-"));
        projectPath = fs.realpathSync(projectPath);
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function write(relativePath: string, value: unknown): string {
        const filePath = path.join(projectPath, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(value));
        return filePath;
    }

    function writeConfig(storageStatePath: string): void {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ auth: { storageStatePath } }),
        );
    }

    it("uses the configured path for reads, writes, and generated-test paths", () => {
        writeConfig("e2e/.auth/admin.json");
        const statePath = write("e2e/.auth/admin.json", {
            cookies: [],
            origins: [{ origin: "https://app.example.com", localStorage: [] }],
        });

        expect(resolveAuthStorageStateDestination(projectPath)).toBe(statePath);
        expect(resolveAuthStorageStatePath(projectPath)).toBe(statePath);
        expect(resolveAuthStorageStateRelativePath(projectPath)).toBe("e2e/.auth/admin.json");
    });

    it("does not fall back to legacy state when an explicit destination is missing", () => {
        writeConfig("e2e/.auth/missing.json");
        write(".raiken/auth-state.json", { cookies: [], origins: [] });

        expect(resolveAuthStorageStatePath(projectPath)).toBeNull();
        expect(resolveAuthStorageStateDestination(projectPath)).toBe(
            path.join(projectPath, "e2e/.auth/missing.json"),
        );
    });

    it("uses the legacy default only when no path is configured", () => {
        const fallback = write(".raiken/auth-state.json", { cookies: [], origins: [] });

        expect(resolveAuthStorageStatePath(projectPath)).toBe(fallback);
        expect(resolveAuthStorageStateDestination(projectPath)).toBe(fallback);
    });

    it("rejects configured state paths outside the project", () => {
        writeConfig("../outside.json");

        expect(() => resolveAuthStorageStateDestination(projectPath)).toThrow(PathContainmentError);
    });

    it("distinguishes missing, malformed, and empty state", () => {
        const missing = inspectAuthState(path.join(projectPath, "missing.json"));
        expect(missing.status).toBe("missing");
        expect(describeAuthStateProblem(missing)).toContain("raiken auth");

        const malformedPath = path.join(projectPath, "malformed.json");
        fs.writeFileSync(malformedPath, "{ nope");
        const malformed = inspectAuthState(malformedPath);
        expect(malformed.status).toBe("malformed");
        expect(describeAuthStateProblem(malformed)).toContain("malformed");

        const empty = inspectAuthState(write("empty.json", { cookies: [], origins: [] }));
        expect(empty.status).toBe("empty");
        expect(describeAuthStateProblem(empty)).toContain("no cookies or origins");
    });

    it("reports persistent-cookie expiry in milliseconds", () => {
        const expires = Math.floor(Date.now() / 1000) - 60;
        const statePath = write("expired.json", {
            cookies: [{ name: "session", value: "stale", expires }],
            origins: [],
        });

        const inspection = inspectAuthState(statePath);
        expect(inspection.status).toBe("expired");
        expect(inspection.expired).toBe(true);
        expect(inspection.expiresAt).toBe(expires * 1000);
        expect(describeAuthStateProblem(inspection)).toContain("expired");
    });

    it("does not call a mixed or session-cookie state expired", () => {
        const past = Math.floor(Date.now() / 1000) - 60;
        const future = Math.floor(Date.now() / 1000) + 60;
        const mixed = inspectAuthState(
            write("mixed.json", {
                cookies: [
                    { name: "old", value: "x", expires: past },
                    { name: "current", value: "y", expires: future },
                ],
                origins: [],
            }),
        );
        const session = inspectAuthState(
            write("session.json", {
                cookies: [{ name: "session", value: "x", expires: -1 }],
                origins: [],
            }),
        );

        expect(mixed.status).toBe("valid");
        expect(session.status).toBe("valid");
    });

    it("accepts localStorage-only state and exposes origin metadata", () => {
        const statePath = write("local-storage.json", {
            cookies: [],
            origins: [{ origin: "https://app.example.com", localStorage: [] }],
        });
        writeConfig("local-storage.json");

        const inspection = inspectAuthState(statePath);
        expect(inspection.status).toBe("valid");
        expect(inspection.origins).toEqual(["https://app.example.com"]);
        expect(resolveUsableAuthStorageStatePath(projectPath)).toBe(statePath);
    });

    it("atomically preserves a good state when a replacement is unusable", () => {
        const statePath = write("session.json", {
            cookies: [{ name: "session", value: "old", expires: -1 }],
            origins: [],
        });

        expect(() => writeValidatedAuthState(statePath, { cookies: [], origins: [] })).toThrow(
            "contains no cookies or origins",
        );
        expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toEqual({
            cookies: [{ name: "session", value: "old", expires: -1 }],
            origins: [],
        });

        writeValidatedAuthState(statePath, {
            cookies: [{ name: "session", value: "new", expires: -1 }],
            origins: [],
        });
        expect(JSON.parse(fs.readFileSync(statePath, "utf-8")).cookies[0].value).toBe("new");
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    });
});
