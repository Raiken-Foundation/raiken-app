/**
 * REPL startup attention banner (ux-7).
 *
 * Before this, state left over from a previous session — a paused
 * discovery run, an unresolved auth blocker, a missing AI key — only
 * surfaced as a confusing failure mid-turn. These tests cover the
 * gathering logic against a real temp project DB (mirrors
 * `discover-resume.spec.ts`'s approach — the interesting behavior lives in
 * the DB query + AI config resolution, not something worth mocking).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CodeGraphDB, canonicalProjectPath, SiteKnowledgeDB } from "@raiken/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherAttentionItems } from "../attention";

const AI_ENV_VARS = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "TOGETHER_API_KEY",
    "PERPLEXITY_API_KEY",
    "AI_API_KEY",
];

describe("gatherAttentionItems", () => {
    let projectPath: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-attention-"));
        for (const key of AI_ENV_VARS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        for (const key of AI_ENV_VARS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it("flags an uninitialized project before the first agent turn", async () => {
        const items = await gatherAttentionItems(projectPath);

        expect(items).toContainEqual(expect.stringContaining("run `raiken init`"));
        expect(items.some((i) => /No AI provider key configured/.test(i))).toBe(false);
    });

    it("flags a missing AI provider key after a provider has been configured", async () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "deepseek" } }),
        );
        const items = await gatherAttentionItems(projectPath);
        expect(items.some((i) => /DeepSeek needs an API key/.test(i))).toBe(true);
    });

    it("does not flag a missing key once the provider's env var is set", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "openrouter" } }),
        );
        const items = await gatherAttentionItems(projectPath);
        expect(items.some((i) => /needs an API key/.test(i))).toBe(false);
    });

    it("says nothing about discovery for a fresh project with no discovery DB yet", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        const items = await gatherAttentionItems(projectPath);
        expect(items.some((i) => /[Dd]iscovery/.test(i))).toBe(false);
    });

    it("flags a paused discovery session with a /discover --continue hint", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        const canonicalPath = canonicalProjectPath(projectPath);
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 3,
                linksFound: 7,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: "https://example.test/dashboard",
                queueJson: JSON.stringify([]),
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }

        const items = await gatherAttentionItems(projectPath);
        const match = items.find((i) => i.includes("Discovery paused"));
        expect(match).toBeDefined();
        expect(match).toContain("https://example.test/");
        expect(match).toContain("3 pages");
        expect(match).toContain("/discover --continue");
    });

    it("flags a failed discovery session with a retry hint", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        const canonicalPath = canonicalProjectPath(projectPath);
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status: "failed",
                pagesDiscovered: 1,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: Date.now(),
                blockedAtUrl: null,
                queueJson: null,
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }

        const items = await gatherAttentionItems(projectPath);
        expect(items.some((i) => i.includes("discovery run failed"))).toBe(true);
    });

    it("says nothing about discovery once a session completed cleanly", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        const canonicalPath = canonicalProjectPath(projectPath);
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status: "completed",
                pagesDiscovered: 12,
                linksFound: 40,
                startedAt: Date.now(),
                completedAt: Date.now(),
                blockedAtUrl: null,
                queueJson: null,
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }

        const items = await gatherAttentionItems(projectPath);
        expect(items.some((i) => /[Dd]iscovery/.test(i))).toBe(false);
    });

    it("passes bootstrap warnings straight through", async () => {
        process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
        const items = await gatherAttentionItems(projectPath, ["some bootstrap warning"]);
        expect(items).toContain("some bootstrap warning");
    });
});
