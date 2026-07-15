/**
 * Deterministic `raiken.config.json` cleanup for `raiken organize`.
 *
 * Deliberately rule-based, not AI-driven: config correctness has a right
 * answer (valid JSON, no duplicate patterns, in sync with the Playwright
 * config actually used to run tests), so there's no reason to spend an LLM
 * call — or introduce LLM unpredictability — on it. AI freeform judgment is
 * reserved for the test-organization side of this command, where "what's a
 * sensible feature grouping" genuinely has no deterministic answer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { raikenConfigSchema } from "../config/schema";
import { readPlaywrightTestDir } from "../testing/playwright-config";
import { toPosixPath } from "./path-utils";
import type { ConfigCleanupChange, ConfigCleanupResult } from "./types";

const KNOWN_TOP_LEVEL_KEYS = new Set(Object.keys(raikenConfigSchema.shape));

/** Fields the schema still accepts but nothing downstream reads. */
const DEAD_FIELDS = ["outputFormats"];

export async function analyzeConfigCleanup(projectPath: string): Promise<ConfigCleanupResult> {
    const configPath = path.join(projectPath, "raiken.config.json");
    if (!fs.existsSync(configPath)) {
        return { changes: [], cleanedConfig: {}, skipped: true };
    }

    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
        return {
            changes: [
                {
                    path: "(file)",
                    description: `raiken.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                    before: undefined,
                    after: undefined,
                },
            ],
            cleanedConfig: {},
            skipped: true,
        };
    }

    const cleaned: Record<string, unknown> = structuredClone(raw);
    const changes: ConfigCleanupChange[] = [];

    dropDeadFields(cleaned, changes);
    dropUnknownTopLevelKeys(cleaned, changes);
    dedupeExcludePatterns(cleaned, changes);
    await syncTestDirectory(cleaned, changes, projectPath);

    // Final safety net: only accept the cleanup if the result still parses.
    // A bug in one of the passes above must never corrupt the user's config.
    const validated = raikenConfigSchema.safeParse(cleaned);
    if (!validated.success) {
        return {
            changes: [
                {
                    path: "(validation)",
                    description: `Cleanup would produce an invalid config (${validated.error.issues[0]?.message ?? "unknown error"}); no changes proposed.`,
                    before: undefined,
                    after: undefined,
                },
            ],
            cleanedConfig: raw,
            skipped: true,
        };
    }

    return { changes, cleanedConfig: cleaned, skipped: false };
}

function dropDeadFields(cleaned: Record<string, unknown>, changes: ConfigCleanupChange[]): void {
    for (const field of DEAD_FIELDS) {
        if (!(field in cleaned)) continue;
        changes.push({
            path: field,
            description: `"${field}" isn't read by any part of Raiken's generation pipeline — removing it.`,
            before: cleaned[field],
            after: undefined,
        });
        delete cleaned[field];
    }
}

function dropUnknownTopLevelKeys(
    cleaned: Record<string, unknown>,
    changes: ConfigCleanupChange[],
): void {
    for (const key of Object.keys(cleaned)) {
        if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue;
        changes.push({
            path: key,
            description: `"${key}" is not a recognized raiken.config.json field — removing it.`,
            before: cleaned[key],
            after: undefined,
        });
        delete cleaned[key];
    }
}

function dedupeExcludePatterns(
    cleaned: Record<string, unknown>,
    changes: ConfigCleanupChange[],
): void {
    const discovery = cleaned["discovery"] as Record<string, unknown> | undefined;
    const patterns = discovery?.["excludePatterns"];
    if (!Array.isArray(patterns)) return;

    const seen = new Set<string>();
    const deduped: unknown[] = [];
    for (const p of patterns) {
        const key = typeof p === "string" ? p.trim() : JSON.stringify(p);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(p);
    }

    if (deduped.length === patterns.length) return;
    changes.push({
        path: "discovery.excludePatterns",
        description: `Removed ${patterns.length - deduped.length} duplicate exclude pattern(s).`,
        before: patterns,
        after: deduped,
    });
    (discovery as Record<string, unknown>)["excludePatterns"] = deduped;
}

async function syncTestDirectory(
    cleaned: Record<string, unknown>,
    changes: ConfigCleanupChange[],
    projectPath: string,
): Promise<void> {
    const configured =
        typeof cleaned["testDirectory"] === "string"
            ? (cleaned["testDirectory"] as string)
            : undefined;
    const playwrightTestDir = await readPlaywrightTestDir(projectPath).catch(() => null);
    if (!playwrightTestDir || !configured) return;

    const normalize = (p: string) =>
        toPosixPath(p)
            .replace(/^\.?\//, "")
            .replace(/\/+$/, "");
    if (normalize(configured) === normalize(playwrightTestDir)) return;

    changes.push({
        path: "testDirectory",
        description:
            `raiken.config.json's testDirectory ("${configured}") doesn't match the ` +
            `Playwright config's testDir ("${playwrightTestDir}") — the two have drifted. ` +
            `Aligning testDirectory to match what Playwright actually runs.`,
        before: configured,
        after: playwrightTestDir,
    });
    cleaned["testDirectory"] = playwrightTestDir;
}
