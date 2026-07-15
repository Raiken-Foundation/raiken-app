/**
 * AI-driven test-organization planning for `raiken organize`.
 *
 * Grouping strategy is intentionally freeform: the model reads every test
 * file's titles + known source-file coverage and proposes its own taxonomy
 * (feature folders, suite folders, whatever fits the project) rather than
 * being locked into a single fixed heuristic (source-module / URL-route /
 * describe-title). That means every proposed move is untrusted input and
 * must be validated against the real file list before it's ever shown to
 * the user, let alone applied.
 */

import { z } from "zod";
import {
    createLangChainModel,
    LLM_REQUEST_TIMEOUT_MS,
    type ResolvedAIConfig,
} from "../agent/ai-providers";
import { toPosixPath } from "./path-utils";
import type { OrganizeWarning, TestInventoryEntry, TestOrganizePlan } from "./types";

/** Only actual spec files may move; helpers/fixtures/page objects stay put. */
const MOVABLE_FILE_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/i;

const planSchema = z.object({
    summary: z.string(),
    moves: z
        .array(
            z.object({
                from: z.string(),
                to: z.string(),
                reason: z.string(),
            }),
        )
        .default([]),
    warnings: z
        .array(
            z.object({
                file: z.string().optional(),
                message: z.string(),
            }),
        )
        .default([]),
});

export async function planTestOrganization(
    inventory: TestInventoryEntry[],
    testDirectory: string,
    resolvedAI: ResolvedAIConfig,
): Promise<TestOrganizePlan> {
    if (inventory.length === 0) {
        return { summary: "No test files found — nothing to organize.", moves: [], warnings: [] };
    }
    if (inventory.length === 1) {
        return {
            summary: "Only one test file exists — no grouping to propose.",
            moves: [],
            warnings: [],
        };
    }

    const model = createLangChainModel(resolvedAI);
    const prompt = buildPrompt(inventory, testDirectory);
    const response = await model.invoke(prompt, { timeout: LLM_REQUEST_TIMEOUT_MS });
    const text = extractText(response.content);

    const parsed = parseModelOutput(text);
    if (!parsed) {
        return {
            summary:
                "The model's response could not be parsed as a valid plan; no changes proposed.",
            moves: [],
            warnings: [{ message: "AI response was not valid JSON — treat this run as a no-op." }],
            usedModel: resolvedAI.model,
        };
    }

    const { moves, warnings } = sanitizeMoves(parsed.moves, inventory, testDirectory);
    warnings.push(...parsed.warnings);

    return { summary: parsed.summary, moves, warnings, usedModel: resolvedAI.model };
}

function buildPrompt(inventory: TestInventoryEntry[], testDirectory: string): string {
    const listing = inventory
        .map((entry) => {
            const titles =
                entry.titles.length > 0
                    ? entry.titles.join(" / ")
                    : "(no describe/test titles found)";
            const sources =
                entry.sourceFiles.length > 0
                    ? entry.sourceFiles.join(", ")
                    : "(no known source-file links)";
            return `- ${entry.relativePath}\n  titles: ${titles}\n  source files: ${sources}`;
        })
        .join("\n");

    return `[ROLE]
You are organizing a Playwright E2E test suite for readability and
maintainability. You decide the taxonomy — group by feature, by user flow,
by suite, whatever best fits what you see below. There is no fixed scheme
to follow.

[TEST DIRECTORY]
${testDirectory}/

[FILES]
${listing}

[TASK]
Propose a reorganization of these files into subdirectories of "${testDirectory}/"
that groups related tests together. Also flag (as warnings, NOT moves) any
files that look like near-duplicates of each other.

[RULES]
- Only reference files from the [FILES] list above. Never invent a path.
- Only propose moves for spec files (*.spec.* / *.test.*). Helpers, fixtures,
  page objects and config files must stay where they are — other files import
  them by relative path.
- "to" must stay under "${testDirectory}/" and keep the same file extension
  as "from".
- Only include a file in "moves" if it should actually move (different
  directory or a clearer filename). Do not list files that are already
  well-placed.
- Prefer directory moves over renames. Only rename a file's basename if the
  current name is uninformative (e.g. "test1.spec.ts").
- Keep the taxonomy shallow: one level of feature/suite folders under
  "${testDirectory}/" is enough. Do not propose deeply nested trees.

[OUTPUT]
Respond with ONLY a single JSON object, no prose, no markdown fences:
{
  "summary": "one sentence describing the taxonomy you used",
  "moves": [{ "from": "...", "to": "...", "reason": "..." }],
  "warnings": [{ "file": "...", "message": "..." }]
}`;
}

function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && "text" in part) {
                    return String((part as { text: unknown }).text ?? "");
                }
                return "";
            })
            .join("");
    }
    return "";
}

function parseModelOutput(text: string): {
    summary: string;
    moves: { from: string; to: string; reason: string }[];
    warnings: OrganizeWarning[];
} | null {
    const stripped = stripCodeFences(text);
    const jsonStart = stripped.indexOf("{");
    const jsonEnd = stripped.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

    try {
        const raw = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));
        const result = planSchema.safeParse(raw);
        if (!result.success) return null;
        return result.data;
    } catch {
        return null;
    }
}

function stripCodeFences(text: string): string {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
    return (fenced ? fenced[1] : text).trim();
}

/**
 * Validate every AI-proposed move against the real inventory. Anything that
 * fails is dropped into `warnings` instead of silently applied or silently
 * discarded — a file-mover acting on untrusted LLM output needs to fail
 * loud, not fail open.
 */
function sanitizeMoves(
    proposed: { from: string; to: string; reason: string }[],
    inventory: TestInventoryEntry[],
    testDirectory: string,
): { moves: TestOrganizePlan["moves"]; warnings: OrganizeWarning[] } {
    const warnings: OrganizeWarning[] = [];
    const knownPaths = new Set(inventory.map((e) => e.relativePath));
    const root = toPosixPath(testDirectory).replace(/\/+$/, "");

    const seenFrom = new Set<string>();
    const takenDestinations = new Set(knownPaths);
    const moves: TestOrganizePlan["moves"] = [];

    for (const move of proposed) {
        const from = toPosixPath(move.from).replace(/^\.\//, "");
        const to = toPosixPath(move.to).replace(/^\.\//, "");

        if (!knownPaths.has(from)) {
            warnings.push({
                file: move.from,
                message: `Skipped: "${move.from}" is not a known test file.`,
            });
            continue;
        }
        if (!MOVABLE_FILE_PATTERN.test(from)) {
            // Helpers/fixtures/page objects are inventoried (they inform the
            // AI's grouping and the collision check below) but must not move:
            // playwright configs and files outside the test directory may
            // reference them by paths we can't see, let alone rewrite.
            warnings.push({
                file: move.from,
                message: `Skipped: "${move.from}" is not a spec file — helpers/fixtures stay put.`,
            });
            continue;
        }
        if (seenFrom.has(from)) {
            warnings.push({
                file: move.from,
                message: `Skipped: duplicate move proposed for "${move.from}".`,
            });
            continue;
        }
        if (to === from) continue; // identity move — silently skip, not worth a warning
        if (!isWithinRoot(to, root) || to.includes("..")) {
            warnings.push({
                file: move.from,
                message: `Skipped: proposed destination "${move.to}" escapes ${testDirectory}/.`,
            });
            continue;
        }
        if (extname(to) !== extname(from)) {
            warnings.push({
                file: move.from,
                message: `Skipped: proposed destination "${move.to}" changes the file extension.`,
            });
            continue;
        }
        if (takenDestinations.has(to)) {
            warnings.push({
                file: move.from,
                message: `Skipped: destination "${move.to}" collides with an existing or already-planned file.`,
            });
            continue;
        }

        seenFrom.add(from);
        takenDestinations.delete(from);
        takenDestinations.add(to);
        moves.push({ from, to, reason: move.reason });
    }

    return { moves, warnings };
}

function isWithinRoot(p: string, root: string): boolean {
    return p === root || p.startsWith(`${root}/`);
}

function extname(p: string): string {
    const idx = p.lastIndexOf(".");
    return idx === -1 ? "" : p.slice(idx);
}
