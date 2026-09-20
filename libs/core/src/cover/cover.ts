/**
 * `raiken cover` — generate a Playwright test from a free-text scenario,
 * a ticket acceptance criterion (`AC-2`), or a code symbol (`LoginForm`).
 *
 * This is the headless test-drafting surface used both by:
 *   - the CLI (`raiken cover ...`)
 *   - the GitHub Actions workflow that responds to `/raiken cover ...` PR
 *     comments
 *
 * Unlike the interactive agent, this path is one-shot and single-LLM-call.
 * It may run a bounded discover when site knowledge is missing, but it does
 * not explore the app interactively. The output is always a `.spec.ts` file
 * that a human reviews before running. The trade-off is intentional: cover is
 * for "draft me something I can iterate on", not "validate the running
 * app for me" — that's `raiken ci` / the dashboard's job.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    callWithTokenBudget,
    extractMessageContent,
    getProvider,
    isEmptyLengthResponse,
    type ResolvedAIConfig,
} from "../agent/ai-providers";
import {
    type AuthPrecondition,
    resolveCoverAuthPrecondition,
    shouldUseStorageState,
} from "../agent/graph/utils";
import type { GroundingReport } from "../agent/grounding";
import { loadTestDirectory } from "../config";
import { authCredentialEnvGuidance } from "../config/auth-credentials";
import { authLivenessBlocks, probeAuthState } from "../config/auth-liveness";
import { resolveAuthStorageStateRelativePath } from "../config/auth-state";
import { CodeGraphDB } from "../database/db";
import { validationError } from "../errors";
import { syncCurrentTicket } from "../integrations/sync";
import type { IntegrationConfig, TicketInfo } from "../integrations/types";
import { readPlaywrightBaseURL } from "../testing/playwright-config";
import {
    baseUrlPathPrefix,
    injectStorageState,
    resolveGotoPathsAgainstBaseUrl,
    rewriteAbsoluteGotosToRelative,
} from "../testing/spec-normalize";
import { assessGeneratedDraft, UNVERIFIED_MARKER } from "./assess-draft";
import { suggestCollectedOutputPath } from "./draft-quality";
import {
    type CoverEvidence,
    formatAuthLoginEvidence,
    gatherCoverEvidence,
    looksLikeAuthScenario,
} from "./evidence";
import { formatNavigationFlows } from "./flows";
import { extractAcs } from "./intent-coverage";
import { ensureSiteKnowledge } from "./knowledge-gate";

/** Re-export for callers that historically imported from cover.ts. */
export { assessTodoMarkers, containsUnverifiedMarker } from "./assess-draft";
export { extractAcs } from "./intent-coverage";

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
    ai?: ResolvedAIConfig;
    /**
     * Optional dry run: skip the LLM call and write a scaffold-only file.
     * Useful for plumbing checks and offline tests.
     */
    dryRun?: boolean;
    /**
     * Skip the cold-start discovery gate (intentional scaffolds / offline
     * tests). Without this, cover refuses or auto-discovers before drafting.
     */
    allowUngrounded?: boolean;
    /**
     * When the draft would be blocked by a restrictive testMatch, widen
     * testMatch to the permissive `*.spec.ts` glob instead of only steering
     * the filename.
     */
    fixConfig?: boolean;
    /**
     * Allow overwriting an existing file at the resolved output path.
     * Without this, cover refuses to clobber a spec that already has
     * content (defaults can steer a draft onto the one file a narrow
     * testMatch collects — silently replacing real tests is data loss).
     */
    force?: boolean;
    /** Progress lines (e.g. auto-discover started) for CLI stderr. */
    onProgress?: (message: string) => void;
    onEvent?: (event: CoverEvent) => void;
}

export type CoverEvent =
    | { type: "target_resolved"; kind: CoverTargetKind; description: string }
    | { type: "ticket_loaded"; ticketId: string; title: string }
    | { type: "symbols_resolved"; matches: Array<{ name: string; file: string }> }
    | {
          type: "knowledge_ensured";
          status: "ready" | "skipped";
          reason?: "allow_ungrounded" | "already_present";
          seedUrl?: string;
          discovered?: boolean;
      }
    | {
          type: "evidence_gathered";
          pages: number;
          snapshots: number;
          sourceSelectors: number;
          baseURL: string | null;
      }
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
    /**
     * Locator check of the draft against discovery snapshots and source
     * markup. Absent in scaffold mode (there is nothing to check).
     */
    grounding?: GroundingReport;
    /**
     * True when the draft cannot run as written — TODO placeholders, invalid
     * syntax, Playwright config mismatch, or locators contradicted by captured
     * pages. The CLI keys its exit message (and exit code) on this.
     */
    needsReview: boolean;
    /** Reviewer-readable reasons behind `needsReview`. */
    reviewReasons: string[];
    /** TODOs in comments only — optional follow-ups, not blockers. */
    todoNotes: number;
    /** TODOs whose code is commented out — the draft cannot run without them. */
    blockingTodos: number;
    /**
     * True when the draft fails a hard gate (does not parse, or Playwright
     * will not collect it). Distinct from soft review reasons so callers can
     * refuse to treat the write as success.
     */
    blocked: boolean;
}

const AC_PATTERN = /^AC-?(\d+)$/i;

export const UNVERIFIED_MARKER_LINE =
    `// ${UNVERIFIED_MARKER} — drafted by raiken cover with unverified steps. ` +
    "Ground it (raiken auth / raiken discover), review, and remove this marker before running.";

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
    const testDir = options.testDirectory ?? loadTestDirectory(projectPath);
    const steeredReasons: string[] = [];

    // When --fix-config is passed, widen a narrow testMatch BEFORE steering.
    // Steering moves the draft onto the single collected basename — which
    // already contains a real test — and the refusal that follows (step 6)
    // tells the user to pass --fix-config, the exact flag they already did.
    // Widening first lets the draft land at its own default filename.
    if (options.fixConfig) {
        const { applyWidenTestMatch } = await import("../doctor/fixes");
        const { isRestrictiveTestMatch } = await import("./draft-quality");
        const { readPlaywrightTestMatch } = await import("../testing/playwright-config");
        const patterns = await readPlaywrightTestMatch(projectPath).catch(() => null);
        if (isRestrictiveTestMatch(patterns)) {
            const fix = await applyWidenTestMatch(projectPath);
            options.onProgress?.(fix.message);
            if (fix.applied) {
                steeredReasons.push(
                    'widened playwright testMatch to ["**/*.spec.ts"] so this draft is collected',
                );
            }
        }
    }

    let outputPath = options.outputPath
        ? path.resolve(projectPath, options.outputPath)
        : path.resolve(projectPath, testDir, defaultFileName(kind, options.target));
    // Default (invented) names often miss a project's narrow testMatch — steer
    // to the single collected basename when that is unambiguous. Explicit
    // --output keeps the caller's path and the hard block below.
    if (!options.outputPath) {
        const steered = await suggestCollectedOutputPath(projectPath, outputPath);
        if (steered) {
            outputPath = steered.path;
            steeredReasons.push(
                `wrote to ${steered.basename} so Playwright testMatch collects the draft — ` +
                    "pass --output to choose a different name (and widen testMatch if needed)",
            );
        }
    }

    // ---- 4. Cold-start knowledge gate (refuse or auto-discover)
    const knowledge = await ensureSiteKnowledge({
        projectPath,
        allowUngrounded: options.allowUngrounded === true,
        needsAuthenticatedKnowledge: looksLikeAuthScenario(resolved.description),
        onProgress: options.onProgress,
    });
    emit({
        type: "knowledge_ensured",
        status: knowledge.status === "ready" ? "ready" : "skipped",
        ...(knowledge.status === "skipped" ? { reason: knowledge.reason } : {}),
        ...(knowledge.status === "ready"
            ? { seedUrl: knowledge.seedUrl, discovered: knowledge.discovered }
            : {}),
    });

    // When a storageState exists, prove it still authenticates — file expiry
    // alone misses session-cookie / localStorage-only "looks valid" states.
    if (!options.allowUngrounded) {
        const liveness = await probeAuthState({ projectPath });
        if (authLivenessBlocks(liveness)) {
            throw validationError(liveness.message, { code: "INVALID_INPUT" });
        }
        if (liveness.status === "live" || liveness.status === "stale") {
            options.onProgress?.(liveness.message);
        }
    }

    // ---- 5. Build prompt + call LLM (or scaffold on --dry-run)
    let body: string;
    let usedModel: string | undefined;
    // The app's actual code, gathered the same way the interactive agent does
    // (keyword index + entry points). Text ARIA snapshots alone make the model
    // guess DOM structure — tabs, pagination, dialogs, option values — and
    // guesses are what fail in the browser. Best-effort: no code graph → the
    // prompt falls back to evidence only.
    const sourceContext = await resolveSourceContext(projectPath, resolved);
    // Always gather — dry-run still needs auth/cold-start gates against real
    // knowledge, and the gatherers degrade to empty when nothing is on disk.
    const evidence = await gatherCoverEvidence(projectPath, resolved.description);
    emit({
        type: "evidence_gathered",
        pages: evidence.pages.length,
        snapshots: evidence.snapshots.length,
        sourceSelectors: evidence.sourceSelectors.length,
        baseURL: evidence.baseURL,
    });
    // Resolve the auth starting condition ONCE, for both the prompt and the
    // storageState injection below. Cover is one-shot — no graph node refines
    // this later — so use the strict resolver that defaults to authenticated
    // and honours only unambiguous login / logged-out signals.
    const precondition = resolveCoverAuthPrecondition(resolved.description);

    const requiresKey = options.ai && getProvider(options.ai.provider).envVars.length > 0;
    if (options.dryRun || !options.ai || (requiresKey && !options.ai.apiKey)) {
        body = buildScaffold(resolved.description, resolved.sourceFiles);
    } else {
        emit({ type: "llm_started" });
        const result = await callLLM(
            options.ai,
            resolved,
            evidence,
            sourceContext,
            precondition,
            projectPath,
        );
        body = result.body;
        usedModel = result.model;
        emit({ type: "llm_finished", bytes: Buffer.byteLength(body, "utf-8") });
    }

    // Deterministic normalizations — same as the agent generation path so
    // cover drafts don't invent absolute URLs against a known baseURL or
    // stall at a login wall when a storageState already exists.
    const authStateRel = shouldUseStorageState(precondition)
        ? resolveAuthStorageStateRelativePath(projectPath)
        : null;
    if (authStateRel) {
        body = injectStorageState(body, authStateRel);
    }
    const baseURL =
        evidence.baseURL ?? (await readPlaywrightBaseURL(projectPath).catch(() => null));
    body = rewriteAbsoluteGotosToRelative(body, baseURL);
    body = resolveGotoPathsAgainstBaseUrl(body, baseURL);

    const assessed = await assessGeneratedDraft({
        body,
        projectPath,
        outputPath,
        evidence,
        description: resolved.description,
        extraReviewReasons: steeredReasons,
    });

    // At the point of pain: draft blocked solely by testMatch — offer/apply
    // the one-shot widen when the caller asked for config fixes.
    if (
        options.fixConfig &&
        assessed.blocked &&
        assessed.reviewReasons.some((r) => /testMatch/i.test(r))
    ) {
        const { applyWidenTestMatch } = await import("../doctor/fixes");
        const { isRestrictiveTestMatch } = await import("./draft-quality");
        const { readPlaywrightTestMatch } = await import("../testing/playwright-config");
        const patterns = await readPlaywrightTestMatch(projectPath).catch(() => null);
        if (isRestrictiveTestMatch(patterns)) {
            const fix = await applyWidenTestMatch(projectPath);
            options.onProgress?.(fix.message);
            if (fix.applied) {
                const reassessed = await assessGeneratedDraft({
                    body,
                    projectPath,
                    outputPath,
                    evidence,
                    description: resolved.description,
                    extraReviewReasons: [
                        ...steeredReasons,
                        `widened playwright testMatch to ["**/*.spec.ts"] so this draft is collected`,
                    ],
                });
                Object.assign(assessed, reassessed);
            }
        }
    }

    // ---- 6. Write the file (even when blocked — reviewers need the artifact,
    // but the CLI exits non-zero so CI cannot treat it as success).

    // Grounding-driven review means the draft asserts things no captured page,
    // source markup, or saved session proves. Stamp the marker so `raiken
    // test` refuses to run it as if it were verified — an unverified draft
    // must not green-light a pipeline.
    const markerStamped =
        assessed.needsReview && assessed.groundingDriven && !body.includes(UNVERIFIED_MARKER);
    if (markerStamped) {
        body = `${UNVERIFIED_MARKER_LINE}\n${body}`;
        assessed.reviewReasons.push(
            `stamped ${UNVERIFIED_MARKER} — raiken test refuses this draft until its unverified ` +
                "steps are grounded (re-run `raiken auth`/`raiken discover`, review, then remove " +
                "the marker; or pass --allow-unverified to run it anyway)",
        );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf-8") : null;
    if (existing !== null && existing !== body && options.force !== true) {
        throw validationError(
            `Refusing to overwrite ${path.relative(projectPath, outputPath)} — it already ` +
                "contains a test. Pass `--output <path>` to choose a different file, " +
                "`--fix-config` (or `raiken doctor --fix`) to widen a narrow testMatch, " +
                "or `--force` to replace the existing content.",
            { code: "INVALID_INPUT" },
        );
    }
    fs.writeFileSync(outputPath, body, "utf-8");
    emit({ type: "file_written", outputPath });

    return {
        kind,
        outputPath,
        bytesWritten: Buffer.byteLength(body, "utf-8"),
        usedModel,
        ticket: resolved.ticket,
        sourceFiles: resolved.sourceFiles,
        grounding: assessed.grounding,
        needsReview: assessed.needsReview,
        reviewReasons: assessed.reviewReasons,
        todoNotes: assessed.todoNotes,
        blockingTodos: assessed.blockingTodos,
        blocked: assessed.blocked,
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

/**
 * The app's actual code as prompt context — the same `gatherContext` the
 * interactive agent repairs with. Explicit targets (AC/symbol) already name
 * source files; free-text scenarios get a keyword-index search. Returns a
 * formatted snippet block, or null when there is no code graph.
 */
async function resolveSourceContext(
    projectPath: string,
    resolved: ResolvedTarget,
): Promise<string | null> {
    try {
        const { gatherContext } = await import("../agent/agent");
        const context = await gatherContext(
            resolved.description,
            projectPath,
            resolved.sourceFiles.length > 0 ? resolved.sourceFiles : undefined,
        );
        if (context.files.length === 0) return null;
        return context.files
            .slice(0, 5)
            .map((file) => `--- ${file.path} ---\n${file.fullContext.slice(0, 1500)}`)
            .join("\n\n");
    } catch {
        return null;
    }
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
 * Extract acceptance criteria — see {@link extractAcs} in intent-coverage.
 * Re-exported above for historical import paths.
 */

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(
    ai: NonNullable<CoverOptions["ai"]>,
    resolved: ResolvedTarget,
    evidence: CoverEvidence,
    sourceContext: string | null,
    precondition: AuthPrecondition,
    projectPath: string,
): Promise<{ body: string; model: string }> {
    const prompt = buildCoverPrompt(resolved, evidence, sourceContext, precondition, projectPath);
    // One factory owns native-provider versus OpenAI-compatible wiring. This
    // keeps `raiken cover` aligned with chat, organize, and repair instead of
    // silently sending every configured provider through OpenRouter's API.
    // The token budget respects the resolved config (never silently below the
    // user's maxTokens), and the empty-length signature — a reasoning model
    // that spent its whole budget thinking — retries once at 2× before the
    // call gives up with a distinct error.
    const response = await callWithTokenBudget({
        ai,
        temperature: 0.4,
        invoke: (llm, timeoutMs) => llm.invoke(prompt, { timeout: timeoutMs }),
        isExhausted: isEmptyLengthResponse,
    });
    const text = extractMessageContent(response);

    return { body: stripCodeFences(text), model: ai.model };
}

/** Auth guidance for the cover prompt, keyed on the resolved precondition. */
function formatCoverAuthGuidance(precondition: AuthPrecondition, projectPath: string): string {
    if (precondition === "login_flow") {
        const lines = [
            "- This scenario tests the sign-in flow itself. Write the login steps: navigate to the",
            "  login page, fill the credential fields, and submit — do NOT skip them and do NOT",
            "  assume a saved session.",
        ];
        const credentialEnv = authCredentialEnvGuidance(projectPath);
        if (credentialEnv) {
            lines.push("- Read credentials from the environment — never hardcode a real password:");
            lines.push(...credentialEnv.split("\n").map((line) => `  ${line}`));
        }
        return lines.join("\n");
    }
    if (precondition === "unauthenticated") {
        return "- This scenario must run logged out. Do not sign in and do not use a saved session.";
    }
    return (
        "- If a reusable auth session exists, the draft will receive test.use({ storageState })\n" +
        "  automatically — do not invent a login flow."
    );
}

function buildCoverPrompt(
    resolved: ResolvedTarget,
    evidence: CoverEvidence,
    sourceContext: string | null,
    precondition: AuthPrecondition,
    projectPath: string,
): string {
    const fileList =
        resolved.sourceFiles.length > 0
            ? resolved.sourceFiles.map((f) => `- ${f}`).join("\n")
            : "(none provided — do NOT guess the app's structure; mark unknowns as TODO)";

    return `[ROLE]
Senior Playwright/TypeScript engineer. Draft ONE focused E2E test for the
scenario below. The test will be reviewed by a human before being run.

[SCENARIO]
${resolved.description}

[RELATED SOURCE FILES]
${fileList}
${sourceContext ? `\n[SOURCE CONTEXT — the app's actual code. Derive structure, options, and flow from it — do not guess.]\n${sourceContext}\n` : ""}
${formatEvidence(evidence)}
[OUTPUT]
- Complete .ts file. No markdown fences. No prose.
- Imports → describe → test cases (Arrange/Act/Assert).
- TypeScript types and async/await. No Jest/Vitest syntax.

[RULES]
- This draft has no live browser. Base every URL and selector on the known
  application context above (and the source files); never invent one. If the
  context lists nothing for a step, mark that step with a \`// TODO:\` comment
  naming the decision the reviewer must make.
- Prefer relative page.goto('/path') against the baseURL above. Do not hardcode
  the origin. Use page.goto only for the initial entry URL. Mid-flow, prefer clicking
  in-app links/buttons from the known page context — full reloads wipe SPA
  client state (cart, wizards, session UI).
${formatCoverAuthGuidance(precondition, projectPath)}
- Selector priority: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText.
- A data-testid that repeats across list rows/cards resolves to MULTIPLE elements
  (strict-mode failure). Scope it to the item's own testid container
  (getByTestId('card-<id>').getByTestId('title')) or use getByRole with the
  specific accessible name instead of a bare shared test id.
- Assertions must be specific and tied to the scenario.
- getByText matches ONE element's full text. Assert individual values — never
  one assertion over concatenated text from separate elements.
- <select> assertions: selectOption takes the option's value or { label };
  toHaveValue asserts the option's value attribute (usually lowercase).
- Content behind tabs, pagination, or confirmation dialogs is not visible
  until you interact with it: switch to the tab, page to the item, confirm the
  dialog — then assert.
- Keep the polarity the scenario asked for. "X is visible" becomes toBeVisible(),
  never .not.toBeVisible() / toHaveCount(0) / toBeHidden() just because the
  known context doesn't show X — that turns an unverified check into a false
  green. Write the assertion as asked and mark the line \`// TODO:\` instead.
- NEVER emit page.waitForTimeout, setTimeout, or sleep — fixed sleeps are
  the largest single source of flakes (~45%, Luo et al., FSE 2014). Use
  expect.toBeVisible({ timeout }) / waitForURL / waitForResponse instead.`;
}

/**
 * Render gathered project evidence as prompt sections. Empty sections are
 * omitted entirely so a project with no discovery/index gets the same prompt
 * shape as before, not empty headings implying evidence that isn't there.
 */
function formatEvidence(evidence: CoverEvidence): string {
    const sections: string[] = [];

    if (evidence.baseURL) {
        const prefix = baseUrlPathPrefix(evidence.baseURL);
        sections.push(
            `[BASE URL]\n${evidence.baseURL}  (page.goto paths resolve against this)${
                prefix
                    ? `\nThis app is served from the sub-path ${prefix}. A leading "/" resolves against the origin and leaves the app, so every path MUST start with ${prefix} — the entry point is page.goto("${prefix}").`
                    : ""
            }`,
        );
    }

    if (evidence.pages.length > 0) {
        const pages = evidence.pages
            .map((page) => `- ${page.url}${page.title ? `  ("${page.title}")` : ""}`)
            .join("\n");
        sections.push(`[DISCOVERED PAGES — the only URLs known to exist]\n${pages}`);
    }

    if (evidence.authLogin) {
        sections.push(formatAuthLoginEvidence(evidence.authLogin));
    }

    if (evidence.flows.length > 0) {
        sections.push(formatNavigationFlows(evidence.flows));
    }

    if (evidence.snapshots.length > 0) {
        sections.push(
            `[CAPTURED PAGE SNAPSHOTS — real elements on the most relevant pages]\n${evidence.snapshots.join("\n\n")}`,
        );
    }

    if (evidence.sourceSelectors.length > 0) {
        const byKind = new Map<string, string[]>();
        for (const selector of evidence.sourceSelectors) {
            const list = byKind.get(selector.kind) ?? [];
            if (!list.includes(selector.value)) list.push(selector.value);
            byKind.set(selector.kind, list);
        }
        const lines: string[] = [];
        const label: Record<string, string> = {
            testId: "test ids (getByTestId)",
            label: "aria-labels (getByLabel / role name)",
            placeholder: "placeholders (getByPlaceholder)",
            role: "explicit roles",
        };
        for (const [kind, values] of byKind) {
            lines.push(`- ${label[kind] ?? kind}: ${values.join(", ")}`);
        }
        sections.push(
            `[SELECTORS PRESENT IN SOURCE MARKUP — safe to use even for states not captured above]\n${lines.join("\n")}`,
        );
    }

    if (evidence.sourceRoutes.length > 0) {
        sections.push(
            `[ROUTES DEFINED IN SOURCE — navigate to these, not invented paths]\n${evidence.sourceRoutes
                .map((route) => `- ${route}`)
                .join("\n")}`,
        );
    }

    if (evidence.knownSelectors.length > 0) {
        const lines = evidence.knownSelectors
            .map((entry) => `- ${entry.element}: ${entry.selector}`)
            .join("\n");
        sections.push(`[SELECTORS PROVEN IN PREVIOUS RUNS]\n${lines}`);
    }

    if (sections.length === 0) return "";
    return `\n${sections.join("\n\n")}\n`;
}

/**
 * Strip markdown fences the model sometimes wraps around the whole file.
 */
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
