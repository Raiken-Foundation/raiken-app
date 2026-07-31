/**
 * `raiken organize` — propose (and, on confirmation, apply) an AI-assisted
 * reorganization of the test directory into feature/suite folders, plus a
 * deterministic `raiken.config.json` cleanup. See `plan.ts` and
 * `config-cleanup.ts` for the two independent halves of this; this file just
 * wires them together behind one options object.
 */

import * as path from "node:path";
import { getProvider, resolveAIConfig } from "../agent/ai-providers";
import { loadTestDirectory } from "../config";
import { analyzeConfigCleanup } from "./config-cleanup";
import { buildTestInventory } from "./inventory";
import { planTestOrganization } from "./plan";
import type { OrganizeOptions, OrganizeResult } from "./types";

export async function runOrganize(options: OrganizeOptions): Promise<OrganizeResult> {
    const projectPath = path.resolve(options.projectPath);
    const testDirectory = options.testDirectory ?? loadTestDirectory(projectPath);

    const includeTests = options.includeTests ?? true;
    const includeConfig = options.includeConfig ?? true;

    const result: OrganizeResult = { testDirectory };

    if (includeConfig) {
        result.configCleanup = await analyzeConfigCleanup(projectPath);
    }

    if (includeTests) {
        const resolved = resolveAIConfig(projectPath, options.ai);
        // Providers like Ollama don't need a key at all — only treat a
        // missing key as a blocker for providers that actually require one.
        const needsKey = getProvider(resolved.provider).envVars.length > 0;
        if (options.skipAI || (needsKey && !resolved.apiKey)) {
            result.testPlan = {
                summary:
                    !needsKey || resolved.apiKey
                        ? "Skipped (--tests-only disabled or explicitly skipped)."
                        : "No AI API key configured — set one with `raiken config <your-key>` (or in the environment) to get test-organization suggestions.",
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
