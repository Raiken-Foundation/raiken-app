import * as path from "node:path";
import { type ResolvedAIConfig, resolveAIConfig } from "../agent/ai-providers";
import { runCi } from "../ci";
import { loadIntegrationsConfig, loadTestDirectory } from "../config";
import { writeProjectContext } from "../context/builder";
import { runCover } from "../cover";
import { scanTests } from "../doctor";
import { queryTrace } from "../trace";
import type { ProjectApplicationContext } from "./context";

async function loadAiAndIntegrations(projectPath: string): Promise<{
    integrationConfig?: Parameters<typeof runCover>[0]["integrations"];
    aiConfig: ResolvedAIConfig;
}> {
    const integrationConfig = loadIntegrationsConfig(projectPath);
    const resolved = resolveAIConfig(projectPath);
    return { integrationConfig, aiConfig: resolved };
}

/** Doctor, context export, cover, trace, and CI orchestration. */
export class QualityApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    runDoctor(input: { testDirectory?: string; extraDirectories?: string[] } = {}) {
        const testDirectory = input.testDirectory ?? loadTestDirectory(this.projectPath);
        return scanTests({
            projectPath: this.projectPath,
            testDirectory,
            extraDirectories: input.extraDirectories,
        });
    }

    async writeContext(
        input: { outputPath?: string; maxRowsPerSection?: number; includeImpact?: boolean } = {},
    ) {
        const result = await writeProjectContext({
            projectPath: this.projectPath,
            outputPath: input.outputPath,
            maxRowsPerSection: input.maxRowsPerSection,
            includeImpact: input.includeImpact,
        });
        return {
            ...result,
            relativePath: path.relative(this.projectPath, result.outputPath),
        };
    }

    async runCover(input: {
        target: string;
        ticketId?: string;
        testDirectory?: string;
        outputPath?: string;
        dryRun?: boolean;
    }) {
        const { integrationConfig, aiConfig } = await loadAiAndIntegrations(this.projectPath);
        const result = await runCover({
            projectPath: this.projectPath,
            target: input.target,
            ticketId: input.ticketId,
            testDirectory: input.testDirectory,
            outputPath: input.outputPath,
            dryRun: input.dryRun,
            integrations: integrationConfig,
            ai: aiConfig,
        });
        return {
            ...result,
            relativePath: path.relative(this.projectPath, result.outputPath),
        };
    }

    queryTrace(input: { trace: string; minConfidence?: number; limit?: number }) {
        return queryTrace({
            projectPath: this.projectPath,
            trace: input.trace,
            minConfidence: input.minConfidence,
            limit: input.limit,
        });
    }

    async runCi(
        input: {
            base?: string;
            head?: string;
            staged?: boolean;
            skipRun?: boolean;
            confidenceThreshold?: number;
            maxTests?: number;
            testTimeout?: number;
        } = {},
    ) {
        const skipRun = input.skipRun ?? true;
        const result = await runCi({
            projectPath: this.projectPath,
            base: input.base,
            head: input.head,
            staged: input.staged,
            skipRun,
            confidenceThreshold: input.confidenceThreshold,
            maxTests: input.maxTests,
            testTimeout: input.testTimeout,
            format: "json",
            outputDir: path.join(this.projectPath, ".raiken", "ci-dashboard"),
        });
        return {
            exitCode: result.exitCode,
            impact: result.impact,
            run: result.run,
        };
    }
}
