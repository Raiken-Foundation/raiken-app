/**
 * `raiken cover` — generate a Playwright test from a free-text scenario,
 * a ticket acceptance criterion (`AC-2`), or a code symbol (`LoginForm`).
 *
 * This is the headless test-drafting surface used both by:
 *   - the CLI (`raiken cover ...`)
 *   - the GitHub Actions workflow that responds to `/raiken cover ...` PR
 *     comments
 *
 * Unlike the interactive agent, this path is one-shot, single-LLM-call,
 * and never opens a browser. The output is always a `.spec.ts` file that
 * a human reviews before running. The trade-off is intentional: cover is
 * for "draft me something I can iterate on", not "validate the running
 * app for me" — that's `raiken ci` / the dashboard's job.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { CodeGraphDB } from "../database/db";
import { syncCurrentTicket } from "../integrations/sync";
import type { IntegrationConfig, TicketInfo } from "../integrations/types";

export type CoverTargetKind = "ac" | "symbol" | "free";

export interface CoverOptions {
    projectPath: string;
    /** The raw target string passed by the user. */
    target: string;
    /** Optional ticket id; falls back to current branch when omitted. */
    ticketId?: string;
    /** Optional explicit output path; defaults to `<testDirectory>/raiken-cover-<slug>.spec.ts`. */
    outputPath?: string;
    /** Override test directory; defaults to raiken.config.json or "e2e". */
    testDirectory?: string;
    /** Provider integration config (GitHub/Jira/Linear). */
    integrations?: IntegrationConfig;
    /** AI config; required for the actual LLM call. */
    ai?: {
        apiKey?: string;
        model?: string;
        baseURL?: string;
    };
    /**
     * Optional dry run: skip the LLM call and write a scaffold-only file.
     * Useful for plumbing checks and offline tests.
     */
    dryRun?: boolean;
    onEvent?: (event: CoverEvent) => void;
}

export type CoverEvent =
    | { type: "target_resolved"; kind: CoverTargetKind; description: string }
    | { type: "ticket_loaded"; ticketId: string; title: string }
    | { type: "symbols_resolved"; matches: Array<{ name: string; file: string }> }
    | { type: "llm_started" }
    | { type: "llm_finished"; bytes: number }
    | { type: "file_written"; outputPath: string };

export interface CoverResult {
    kind: CoverTargetKind;
    outputPath: string;
    bytesWritten: number;
    /** Empty when --dry-run or no AI key. */
    usedModel?: string;
    /** Resolved ticket, if any. */
    ticket?: TicketInfo;
    /** Resolved source files used as context for the LLM. */
    sourceFiles: string[];
}

const AC_PATTERN = /^AC-?(\d+)$/i;

export async function runCover(options: CoverOptions): Promise<CoverResult> {
    const projectPath = path.resolve(options.projectPath);
    const emit = options.onEvent ?? (() => {});

    // ---- 1. Classify the target
    const kind = classifyTarget(options.target);

    // ---- 2. Resolve into (description, sourceFiles, ticket)
    const resolved = await resolveTarget(options, projectPath, kind, emit);

    emit({
        type: "target_resolved",
        kind,
        description: resolved.description.slice(0, 200),
    });

    // ---- 3. Determine output path
    const testDir = options.testDirectory ?? loadTestDirectory(projectPath) ?? "e2e";
    const outputPath = options.outputPath
        ? path.resolve(projectPath, options.outputPath)
        : path.resolve(projectPath, testDir, defaultFileName(kind, options.target));

    // ---- 4. Build prompt + call LLM (or scaffold on --dry-run)
    let body: string;
    let usedModel: string | undefined;
    if (options.dryRun || !options.ai?.apiKey) {
        body = buildScaffold(resolved.description, resolved.sourceFiles);
    } else {
        emit({ type: "llm_started" });
        const result = await callLLM(options.ai, resolved);
        body = result.body;
        usedModel = result.model;
        emit({ type: "llm_finished", bytes: Buffer.byteLength(body, "utf-8") });
    }

    // ---- 5. Write the file
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body, "utf-8");
    emit({ type: "file_written", outputPath });

    return {
        kind,
        outputPath,
        bytesWritten: Buffer.byteLength(body, "utf-8"),
        usedModel,
        ticket: resolved.ticket,
        sourceFiles: resolved.sourceFiles,
    };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
    description: string;
    sourceFiles: string[];
    ticket?: TicketInfo;
}

function classifyTarget(target: string): CoverTargetKind {
    const trimmed = target.trim();
    if (AC_PATTERN.test(trimmed)) return "ac";
    // Heuristic: a single identifier-shaped token is a symbol; everything
    // else (multiple words, sentences) is a free-text scenario.
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && trimmed.length >= 3) return "symbol";
    return "free";
}

async function resolveTarget(
    options: CoverOptions,
    projectPath: string,
    kind: CoverTargetKind,
    emit: (e: CoverEvent) => void,
): Promise<ResolvedTarget> {
    if (kind === "ac") {
        return resolveAc(options, projectPath, emit);
    }
    if (kind === "symbol") {
        return resolveSymbol(options.target, projectPath, emit);
    }
    return { description: options.target.trim(), sourceFiles: [] };
}

async function resolveAc(
    options: CoverOptions,
    projectPath: string,
    emit: (e: CoverEvent) => void,
): Promise<ResolvedTarget> {
    const match = AC_PATTERN.exec(options.target.trim());
    if (!match) throw new Error(`Invalid AC reference: "${options.target}"`);
    const acIndex = Number(match[1]);

    const sync = await syncCurrentTicket({
        projectPath,
        config: options.integrations,
        ticketId: options.ticketId,
        ai: options.ai,
    });

    if (!sync.ticket) {
        throw new Error(
            "Could not resolve a ticket for the current branch. " +
                "Pass --ticket <id>, or check your integration config.",
        );
    }

    emit({
        type: "ticket_loaded",
        ticketId: sync.ticket.id,
        title: sync.ticket.title,
    });

    const acs = extractAcs(sync.ticket.description);
    if (acs.length === 0) {
        throw new Error(
            `No acceptance criteria found in ticket "${sync.ticket.title}". ` +
                "Use a numbered list, checkboxes, or `AC1:` prefixes in the description.",
        );
    }

    const acText = acs[acIndex - 1];
    if (!acText) {
        throw new Error(
            `Ticket has ${acs.length} AC(s); ${acIndex} is out of range. ` +
                `Available: ${acs.map((_, i) => `AC-${i + 1}`).join(", ")}.`,
        );
    }

    const sourceFiles = (sync.impact?.affectedSourceFiles ?? []).slice(0, 8);
    return {
        description: `Acceptance criterion ${acIndex} of ticket "${sync.ticket.title}":\n  ${acText}`,
        sourceFiles,
        ticket: sync.ticket,
    };
}

function resolveSymbol(
    name: string,
    projectPath: string,
    emit: (e: CoverEvent) => void,
): ResolvedTarget {
    const db = new CodeGraphDB(projectPath);
    let matches: ReturnType<typeof db.findSymbolsByName>;
    try {
        matches = db.findSymbolsByName(name.trim(), { limit: 5 });
    } finally {
        db.close();
    }

    if (matches.length === 0) {
        throw new Error(
            `No symbol named "${name}" found in the code graph. Run \`raiken sync\` (or rebuild the graph) and retry.`,
        );
    }

    emit({
        type: "symbols_resolved",
        matches: matches.map((m) => ({ name: m.symbol.name, file: m.file })),
    });

    const sourceFiles = Array.from(new Set(matches.map((m) => m.file)));
    const sigs = matches
        .map((m) => `- ${m.symbol.kind} \`${m.symbol.name}\` in \`${m.file}\``)
        .join("\n");

    return {
        description: `Cover the user-visible behaviour of symbol \`${name}\`.\nKnown definitions:\n${sigs}`,
        sourceFiles,
    };
}

/**
 * Extract acceptance criteria from a ticket description. Supports the
 * three common conventions:
 *   - "AC1: ..." / "AC-1: ..." prefixed lines
 *   - "- [ ] ..." or "- [x] ..." checkbox bullets
 *   - "1. ..." numbered list items (only when no AC prefix is present)
 *
 * If the description mixes conventions, AC-prefixed wins.
 */
export function extractAcs(description: string): string[] {
    const lines = description.split(/\r?\n/);
    const acPrefixed: string[] = [];
    const checkboxes: string[] = [];
    const numbered: string[] = [];

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const acMatch = /^AC[-:\s]?(\d+)[.:\s)]+(.+)$/i.exec(line);
        if (acMatch) {
            acPrefixed.push(acMatch[2].trim());
            continue;
        }

        const cbMatch = /^[-*]\s*\[[\sxX]\]\s*(.+)$/.exec(line);
        if (cbMatch) {
            checkboxes.push(cbMatch[1].trim());
            continue;
        }

        const numMatch = /^(\d+)[.):]\s*(.+)$/.exec(line);
        if (numMatch) {
            numbered.push(numMatch[2].trim());
        }
    }

    if (acPrefixed.length > 0) return acPrefixed;
    if (checkboxes.length > 0) return checkboxes;
    return numbered;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(
    ai: NonNullable<CoverOptions["ai"]>,
    resolved: ResolvedTarget,
): Promise<{ body: string; model: string }> {
    const model = ai.model || "anthropic/claude-sonnet-4.5";
    const llm = new ChatOpenAI({
        apiKey: ai.apiKey,
        model,
        temperature: 0.4,
        maxTokens: 1500,
        configuration: { baseURL: ai.baseURL || "https://openrouter.ai/api/v1" },
    });

    const prompt = buildCoverPrompt(resolved);
    const response = await llm.invoke(prompt);
    const text =
        typeof response.content === "string"
            ? response.content
            : Array.isArray(response.content)
              ? response.content
                    .map((p) => (typeof p === "string" ? p : "text" in p ? p.text : ""))
                    .join("")
              : "";

    return { body: stripCodeFences(text), model };
}

function buildCoverPrompt(resolved: ResolvedTarget): string {
    const fileList =
        resolved.sourceFiles.length > 0
            ? resolved.sourceFiles.map((f) => `- ${f}`).join("\n")
            : "(none provided — infer from the scenario)";

    return `[ROLE]
Senior Playwright/TypeScript engineer. Draft ONE focused E2E test for the
scenario below. The test will be reviewed by a human before being run.

[SCENARIO]
${resolved.description}

[RELATED SOURCE FILES]
${fileList}

[OUTPUT]
- Complete .ts file. No markdown fences. No prose.
- Imports → describe → test cases (Arrange/Act/Assert).
- TypeScript types and async/await. No Jest/Vitest syntax.

[RULES]
- Selector priority: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText.
- Assertions must be specific and tied to the scenario.
- NEVER emit page.waitForTimeout, setTimeout, or sleep — fixed sleeps are
  the largest single source of flakes (~45%, Luo et al., FSE 2014). Use
  expect.toBeVisible({ timeout }) / waitForURL / waitForResponse instead.
- If you don't know a real selector or URL, leave a TODO comment with the
  decision the reviewer must make. Do not invent.`;
}

function stripCodeFences(text: string): string {
    const body = text.trim();
    // If the whole response is wrapped in a single fenced block (possibly with
    // prose before/after it), extract the fenced content. Otherwise strip a
    // bare leading/trailing fence.
    const fencedBlock = /```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```/.exec(body);
    if (fencedBlock) return `${fencedBlock[1].trim()}\n`;
    return `${body
        .replace(/^```[a-zA-Z]*\n/, "")
        .replace(/\n```\s*$/, "")
        .trim()}\n`;
}

// ---------------------------------------------------------------------------
// Scaffold (--dry-run / no API key)
// ---------------------------------------------------------------------------

function buildScaffold(description: string, sourceFiles: string[]): string {
    const filesComment =
        sourceFiles.length > 0
            ? sourceFiles.map((f) => ` *   - ${f}`).join("\n")
            : " *   (no related files identified)";

    return `import { test, expect } from "@playwright/test";

/**
 * Drafted by raiken cover (scaffold mode — no LLM call was made).
 *
 * Scenario:
 *   ${description.replace(/\n/g, "\n *   ")}
 *
 * Related source files:
${filesComment}
 *
 * TODO: replace this scaffold with the real flow before merging.
 *       Avoid page.waitForTimeout — wait on real conditions instead.
 */
test.describe("TODO: name this suite", () => {
    test("TODO: name this case", async ({ page }) => {
        // Arrange
        await page.goto("/"); // TODO: pick the real entry URL.

        // Act
        // TODO: drive the flow described in the scenario above.

        // Assert
        await expect(page).toHaveURL(/.*/); // TODO: assert the real outcome.
    });
});
`;
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

function loadTestDirectory(projectPath: string): string | undefined {
    try {
        const raw = JSON.parse(
            fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8"),
        );
        if (typeof raw?.testDirectory === "string") return raw.testDirectory;
    } catch {
        // ignore
    }
    return undefined;
}

function defaultFileName(kind: CoverTargetKind, target: string): string {
    const slug = target
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    const prefix = kind === "ac" ? "ac" : kind === "symbol" ? "sym" : "scn";
    const stamp = `${Date.now().toString(36)}`;
    return `cover-${prefix}-${slug || stamp}.spec.ts`;
}
