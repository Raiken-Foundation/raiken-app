import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    applyConfigPatch,
    PathContainmentError,
    redactConfig,
    resolvePathWithinProject,
    writeConfigAtomic,
} from "../config";

const temporaryDirectories: string[] = [];

async function makeProject(): Promise<string> {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-config-store-"));
    temporaryDirectories.push(projectPath);
    return projectPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("configuration store", () => {
    it("preserves omitted or blank secret drafts and clears only explicitly", () => {
        const existing = {
            ai: {
                provider: "openrouter",
                apiKey: "sk-legacy-secret",
                apiKeys: { openai: "sk-openai-secret" },
                model: "old-model",
            },
        };

        const afterPublicPatch = applyConfigPatch(existing, {
            ai: { model: "new-model", apiKey: "" },
        });
        expect(afterPublicPatch).toMatchObject({
            ai: {
                apiKey: "sk-legacy-secret",
                apiKeys: { openai: "sk-openai-secret" },
                model: "new-model",
            },
        });

        const afterReplacement = applyConfigPatch(existing, {
            ai: { apiKey: "sk-replacement" },
        });
        expect((afterReplacement["ai"] as Record<string, unknown>)["apiKey"]).toBe(
            "sk-replacement",
        );

        const afterExplicitClear = applyConfigPatch(existing, {}, [
            "ai.apiKey",
            "ai.apiKeys.openai",
        ]);
        expect(afterExplicitClear).toEqual({
            ai: { provider: "openrouter", apiKeys: {}, model: "old-model" },
        });
    });

    it("redacts every registered credential while preserving presence metadata", () => {
        const publicConfig = redactConfig({
            ai: {
                apiKey: "sk-secret",
                apiKeys: { openai: "sk-openai" },
            },
            auth: { credentials: { username: "alice", password: "hunter2" } },
            integrations: {
                github: { token: "ghp_secret", owner: "acme" },
                jira: { apiToken: "jira-secret" },
                linear: { apiKey: "lin_api_secret" },
            },
        });

        expect(JSON.stringify(publicConfig)).not.toContain("secret");
        expect(publicConfig).toMatchObject({
            ai: { apiKeyPresent: true, apiKeysPresent: { openai: true } },
            auth: { credentials: { usernamePresent: true, passwordPresent: true } },
            integrations: {
                github: { tokenPresent: true, owner: "acme" },
                jira: { apiTokenPresent: true },
                linear: { apiKeyPresent: true },
            },
        });
    });

    it("writes configuration atomically through the canonical project path", async () => {
        const projectPath = await makeProject();
        await writeConfigAtomic(projectPath, { ai: { model: "test-model" } });

        await expect(
            fs.readFile(path.join(projectPath, "raiken.config.json"), "utf-8"),
        ).resolves.toContain('"test-model"');
    });

    it("rejects traversal outside the project boundary", async () => {
        const projectPath = await makeProject();
        expect(() => resolvePathWithinProject(projectPath, "../outside.txt")).toThrow(
            PathContainmentError,
        );
    });

    it("rejects a symlink inside the project that escapes the project boundary", async () => {
        const projectPath = await makeProject();
        const outsidePath = await makeProject();
        await fs.symlink(outsidePath, path.join(projectPath, "escape"), "dir");

        expect(() => resolvePathWithinProject(projectPath, "escape/private.txt")).toThrow(
            PathContainmentError,
        );
    });

    it("accepts an absolute path reaching the project through a symlinked ancestor", async () => {
        // `os.tmpdir()` is `/var/…` on macOS while its realpath is
        // `/private/var/…`. Callers legitimately pass the uncanonicalized form.
        const projectPath = await makeProject();
        const real = await fs.realpath(projectPath);

        expect(resolvePathWithinProject(projectPath, projectPath)).toBe(real);
        expect(
            resolvePathWithinProject(projectPath, path.join(projectPath, "e2e/new.spec.ts")),
        ).toBe(path.join(real, "e2e/new.spec.ts"));
    });

    it("returns a canonical path for a not-yet-created file", async () => {
        const projectPath = await makeProject();
        const real = await fs.realpath(projectPath);

        expect(resolvePathWithinProject(projectPath, "deep/nested/未created.txt")).toBe(
            path.join(real, "deep/nested/未created.txt"),
        );
    });
});
