/**
 * Config loading helpers that read `raiken.config.json` off disk.
 *
 * `schema.ts` stays pure (zod definitions + in-memory defaults/merging) so it
 * has no I/O and is trivial to unit test; this file is the one place that
 * actually touches the filesystem for the sections that need a "give me the
 * resolved value right now" helper.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import { type AutonomyConfig, defaultConfig } from "./schema";

/**
 * Resolve the `autonomy` section of `raiken.config.json`, merged with
 * defaults, and optionally with a session-scoped override on top (e.g. the
 * CLI REPL's `/mode` command reflecting the *current* run's autonomy without
 * permanently rewriting the project's shared config file).
 *
 * This is the single source of truth for autonomy settings — every consumer
 * (tool execution gates, the repair node, the run-verification node) must
 * resolve through this so `autoCorrect`/`maxRetries`/etc. behave identically
 * everywhere instead of each call site keeping its own independent JSON read
 * + defaults that can silently drift out of sync with each other.
 */
export function loadAutonomyConfig(
    projectPath: string,
    override?: Partial<AutonomyConfig>,
): Required<AutonomyConfig> {
    let onDisk: Partial<AutonomyConfig> = {};
    try {
        const raw = fsSync.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8");
        const parsed = JSON.parse(raw) as { autonomy?: Partial<AutonomyConfig> };
        if (parsed.autonomy && typeof parsed.autonomy === "object") {
            onDisk = parsed.autonomy;
        }
    } catch {
        // Config missing or invalid — fall back to defaults below.
    }
    return { ...defaultConfig.autonomy, ...onDisk, ...override };
}
