/**
 * TicketAnalyzer
 *
 * Maps a ticket (issue/PR) to codebase impact:
 *  1. If the ticket is a PR with changed files → direct file matching
 *  2. For issues → LLM extracts likely affected components,
 *     then semantic + keyword search finds relevant source files
 *  3. getAffectedTests() maps source files → test files
 *
 * Result: a TicketImpact with affected files, tests, and suggestions.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { CodeGraphDB } from "../database/db";
import { ProjectContext } from "../analysis/project-context";
import { GraphQueryService } from "../analysis/graph-query";
import { EmbeddingsGenerator } from "../database/embeddings";
import type {
    TicketInfo,
    TicketImpact,
    TicketImpactReason,
    TicketSuggestion,
    SuggestionAction,
} from "./types";

interface AnalyzerConfig {
    apiKey?: string;
    model?: string;
    baseURL?: string;
}

const impactSchema = z.object({
    affectedComponents: z
        .array(z.string())
        .describe("Names of components, modules, pages, or features likely affected by this ticket"),
    affectedKeywords: z
        .array(z.string())
        .describe("Code-level keywords: function names, class names, route paths, CSS selectors, API endpoints"),
    testImpact: z
        .enum(["new_tests_needed", "existing_tests_need_update", "no_test_impact", "unclear"])
        .describe("Whether this ticket requires new tests, updates to existing tests, or has no test impact"),
    reasoning: z
        .string()
        .describe("Brief explanation of why these components/keywords are affected"),
});

type ImpactAnalysis = z.infer<typeof impactSchema>;

export class TicketAnalyzer {
    private projectPath: string;
    private config: AnalyzerConfig;

    constructor(projectPath: string, config?: AnalyzerConfig) {
        this.projectPath = projectPath;
        this.config = config || {};
    }

    async analyze(ticket: TicketInfo): Promise<TicketImpact> {
        const affectedSourceFiles: string[] = [];

        // Phase 1: Direct file matches from PR diffs
        if (ticket.changedFiles && ticket.changedFiles.length > 0) {
            for (const f of ticket.changedFiles) {
                if (f.status !== "removed") {
                    affectedSourceFiles.push(f.path);
                }
            }
        }

        // Phase 2: LLM analysis for semantic understanding
        let llmAnalysis: ImpactAnalysis | null = null;
        const apiKey = this.config.apiKey || process.env["OPENROUTER_API_KEY"];
        if (apiKey) {
            llmAnalysis = await this.llmAnalyze(ticket, apiKey);
        }

        // Phase 3: Keyword + semantic search for files not in the diff
        if (llmAnalysis) {
            const keywordFiles = this.keywordSearch(llmAnalysis);
            const semanticFiles = await this.semanticSearch(ticket, llmAnalysis);

            for (const f of [...keywordFiles, ...semanticFiles]) {
                if (!affectedSourceFiles.includes(f)) {
                    affectedSourceFiles.push(f);
                }
            }
        }

        // Phase 4: Map source files to affected tests using the explainable
        // GraphQueryService. Falls back to the legacy result shape so older
        // suggestion logic and downstream consumers keep working.
        const query = new GraphQueryService(this.projectPath);
        const evidence = query.getAffectedTests(affectedSourceFiles);

        const affectedTestFiles = evidence.map((row) => ({
            testFile: row.testFile,
            sourceFile: row.sourceFile,
            // Pick the most authoritative reason for the legacy enum.
            reason: this.legacyReason(row.reasons.map((r) => r.reason)),
            confidence: row.confidence,
            evidence: row.reasons.map<TicketImpactReason>((r) => ({
                reason: r.reason as TicketImpactReason["reason"],
                provenance: (r.provenance ?? "static_ast") as TicketImpactReason["provenance"],
                confidence: r.confidence,
                line: r.line,
                snippet: r.snippet,
                sourceSymbol: r.sourceSymbol,
                targetSymbol: r.targetSymbol,
            })),
        }));

        const symbolEvidence = query.getAffectedSymbols(affectedSourceFiles).slice(0, 25);
        const affectedSymbols = symbolEvidence.map((row) => ({
            file: row.file,
            name: row.symbol.name,
            kind: row.symbol.kind,
            startLine: row.symbol.startLine,
            endLine: row.symbol.endLine,
            confidence: row.confidence,
        }));

        // Phase 5: Generate suggestions (use legacy reason shape for compatibility)
        const legacyTestFiles = affectedTestFiles.map((t) => ({
            testFile: t.testFile,
            reason: t.reason,
            sourceFile: t.sourceFile,
        }));
        const suggestions = this.buildSuggestions(
            ticket,
            affectedSourceFiles,
            legacyTestFiles,
            llmAnalysis,
        );

        const summary = this.buildSummary(ticket, affectedSourceFiles, legacyTestFiles, llmAnalysis);

        return {
            ticket,
            affectedSourceFiles,
            affectedTestFiles,
            affectedSymbols,
            summary,
            suggestions,
            analyzedAt: new Date().toISOString(),
        };
    }

    /**
     * Map graph-query reasons to the legacy `source_map | dependency | semantic`
     * enum the rest of the system already understands.
     */
    private legacyReason(reasons: string[]): "source_map" | "dependency" | "semantic" {
        if (reasons.includes("source_map")) return "source_map";
        if (reasons.includes("imports") || reasons.includes("calls") || reasons.includes("renders") || reasons.includes("runtime")) {
            return "dependency";
        }
        return "semantic";
    }

    // =========================================================================
    // LLM Analysis
    // =========================================================================

    private async llmAnalyze(
        ticket: TicketInfo,
        apiKey: string,
    ): Promise<ImpactAnalysis | null> {
        try {
            const model = new ChatOpenAI({
                apiKey,
                model: this.config.model || "anthropic/claude-sonnet-4.5",
                temperature: 0.3,
                maxTokens: 1000,
                configuration: {
                    baseURL: this.config.baseURL || "https://openrouter.ai/api/v1",
                },
            });

            const ctx = ProjectContext.getInstance(this.projectPath);
            const allFiles = ctx.isInitialized() ? ctx.getAllFilePaths().slice(0, 200) : [];

            const systemPrompt = `Identify which parts of the codebase a ticket likely affects.

Project files (sample):
${allFiles.map((f) => `  ${f}`).join("\n")}

Use real names from the project: function/component names, route paths, API endpoints, CSS selectors. Only list items you have reasonable confidence in; do not guess.`;

            const ticketText = `# ${ticket.title}

${ticket.description}

Labels: ${ticket.labels.join(", ") || "none"}
${ticket.changedFiles ? `\nChanged files:\n${ticket.changedFiles.map((f) => `  ${f.status}: ${f.path}`).join("\n")}` : ""}`;

            const structured = model.withStructuredOutput(impactSchema, {
                name: "analyze_ticket_impact",
            });

            return await structured.invoke([
                new SystemMessage(systemPrompt),
                new HumanMessage(ticketText),
            ]);
        } catch (err) {
            console.warn(
                "[TicketAnalyzer] LLM analysis failed:",
                err instanceof Error ? err.message : err,
            );
            return null;
        }
    }

    // =========================================================================
    // Search
    // =========================================================================

    private keywordSearch(analysis: ImpactAnalysis): string[] {
        const ctx = ProjectContext.getInstance(this.projectPath);
        if (!ctx.isInitialized()) return [];

        const allKeywords = [
            ...analysis.affectedComponents,
            ...analysis.affectedKeywords,
        ];

        const query = allKeywords.join(" ");
        return ctx.findRelevantFiles(query, 15);
    }

    private async semanticSearch(
        ticket: TicketInfo,
        analysis: ImpactAnalysis,
    ): Promise<string[]> {
        const embGen = EmbeddingsGenerator.getInstance();
        if (!embGen.isReady()) return [];

        const db = new CodeGraphDB(this.projectPath);
        try {
            const queryText = `${ticket.title}. ${analysis.affectedComponents.join(", ")}. ${analysis.affectedKeywords.join(", ")}`;
            const queryEmbedding = await embGen.generateEmbedding(queryText);
            const results = db.searchSimilar(queryEmbedding, 10);
            return results.map((r) => r.filePath);
        } catch {
            return [];
        } finally {
            db.close();
        }
    }

    // =========================================================================
    // Suggestion Generation
    // =========================================================================

    private buildSuggestions(
        ticket: TicketInfo,
        sourceFiles: string[],
        testFiles: Array<{ testFile: string; reason: string; sourceFile: string }>,
        analysis: ImpactAnalysis | null,
    ): TicketSuggestion[] {
        const suggestions: TicketSuggestion[] = [];

        if (testFiles.length > 0) {
            const uniqueTests = [...new Set(testFiles.map((t) => t.testFile))];
            for (const testFile of uniqueTests) {
                suggestions.push({
                    action: "update_test" as SuggestionAction,
                    testFile,
                    reason: `Test covers source files changed by #${ticket.id}`,
                });
            }
        }

        if (
            analysis?.testImpact === "new_tests_needed" ||
            (sourceFiles.length > 0 && testFiles.length === 0)
        ) {
            const featureName = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
            suggestions.push({
                action: "create_test" as SuggestionAction,
                reason: `No existing tests cover the files affected by #${ticket.id}`,
                suggestedPrompt: `Generate E2E tests for the changes in ticket "${ticket.title}". Focus on: ${sourceFiles.slice(0, 5).join(", ")}`,
            });
        }

        if (analysis?.testImpact === "no_test_impact" && testFiles.length === 0) {
            suggestions.push({
                action: "no_action" as SuggestionAction,
                reason: "This ticket is unlikely to affect existing tests",
            });
        }

        if (suggestions.length === 0 && sourceFiles.length > 0) {
            suggestions.push({
                action: "review_test" as SuggestionAction,
                reason: `${sourceFiles.length} source files may be affected; manual review recommended`,
            });
        }

        return suggestions;
    }

    private buildSummary(
        ticket: TicketInfo,
        sourceFiles: string[],
        testFiles: Array<{ testFile: string; reason: string; sourceFile: string }>,
        analysis: ImpactAnalysis | null,
    ): string {
        const parts: string[] = [];
        parts.push(`Ticket #${ticket.id}: ${ticket.title}`);

        if (sourceFiles.length > 0) {
            parts.push(`${sourceFiles.length} source file(s) affected`);
        } else {
            parts.push("No direct source file impact detected");
        }

        const uniqueTests = new Set(testFiles.map((t) => t.testFile));
        if (uniqueTests.size > 0) {
            parts.push(`${uniqueTests.size} test file(s) may need updates`);
        } else {
            parts.push("No existing tests cover the affected files");
        }

        if (analysis?.reasoning) {
            parts.push(analysis.reasoning);
        }

        return parts.join(". ") + ".";
    }
}
