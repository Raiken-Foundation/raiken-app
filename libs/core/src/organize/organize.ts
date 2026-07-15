/**
 * `raiken organize` — propose (and, on confirmation, apply) an AI-assisted
 * reorganization of the test directory into feature/suite folders, plus a
 * deterministic `raiken.config.json` cleanup. See `plan.ts` and
 * `config-cleanup.ts` for the two independent halves of this; this file just
 * wires them together behind one options object.
 */

import * as path from "node:path";
import { resolveAIConfig } from "../agent/ai-providers";
import { readConfiguredTestDirectory } from "../utils";
import { analyzeConfigCleanup } from "./config-cleanup";
import { buildTestInventory } from "./inventory";
import { planTestOrganization } from "./plan";
import type { OrganizeOptions, OrganizeResult } from "./types";

export async function runOrganize(options: OrganizeOptions): Promise<OrganizeResult> {
    const projectPath = path.resolve(options.projectPath);
    const testDirectory =
        options.testDirectory ?? readConfiguredTestDirectory(projectPath) ?? "e2e";

    const includeTests = options.includeTests ?? true;
    const includeConfig = options.includeConfig ?? true;

    const result: OrganizeResult = { testDirectory };

    if (includeConfig) {
        result.configCleanup = await analyzeConfigCleanup(projectPath);
    }

    if (includeTests) {
        const resolved = resolveAIConfig(projectPath, options.ai);
        if (options.skipAI || !resolved.apiKey) {
            result.testPlan = {
                summary: resolved.apiKey
                    ? "Skipped (--tests-only disabled or explicitly skipped)."
                    : "No AI API key configured — set one in raiken.config.json or the environment to get test-organization suggestions.",
                moves: [],
                warnings: [],
            };
        } else {
            const inventory = buildTestInventory(projectPath, testDirectory);
            result.testPlan = await planTestOrganization(inventory, testDirectory, resolved);
        }
    }

    return result;
}
