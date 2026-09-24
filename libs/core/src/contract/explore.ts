import { chromium, type Page } from "playwright";
import { callWithTokenBudget, extractMessageContent } from "../agent/ai-providers";
import type { ResolvedAIConfig } from "../agent/ai-providers";
import { matchScore } from "./coverage";
import { mintObservedFact } from "./mint";
import { ContractStore } from "./store";
import type { BehaviorFact, FactEvidence, IntentFact } from "./types";
import { resolveFactUrl } from "./verify";

/**
 * The explorer: hunts uncovered requirements and mints facts for them.
 *
 * The uncovered-requirements queue is the exploration target list — the LLM
 * plans a bounded action sequence against the known routes/forms, the plan is
 * executed in a real browser under the destructive-label blocklist, and any
 * DOM delta that matches the requirement's tokens is minted as an observed
 * fact with before/after evidence. Exploration stops being random wandering
 * and becomes "go prove this requirement."
 */

export const DESTRUCTIVE_LABEL =
    /delete|remove|archive|sign out|logout|clear all|reset|confirm|unsubscribe|place order|pay now/i;

const MAX_PLAN_STEPS = 12;
const MAX_REQUIREMENTS_PER_RUN = 3;

interface PlanStep {
    action: "goto" | "fill" | "click" | "observe";
    /** For goto: a route path or hash; for fill/click: a label/selector-ish target. */
    target: string;
    value?: string;
}

interface ExplorationPlan {
    steps: PlanStep[];
    note?: string;
}

export interface ExploreOutcome {
    requirementText: string;
    factsMinted: number;
    covered: boolean;
    executedSteps: number;
    failure?: string;
}

export interface ExplorerOptions {
    baseURL: string;
    intents: IntentFact[];
    observed: BehaviorFact[];
    routes: Array<{ path: string; url: string }>;
    formsByRoute: Map<string, { fields: Array<{ label?: string }>; submits: string[] }>;
    ai: ResolvedAIConfig;
    store: ContractStore;
    storageStatePath?: string | null;
    headless?: boolean;
    maxRequirements?: number;
}

export async function exploreUncovered(options: ExplorerOptions): Promise<ExploreOutcome[]> {
    const queue = options.intents
        .filter((i) => i.status === "uncovered")
        .slice(0, options.maxRequirements ?? MAX_REQUIREMENTS_PER_RUN);
    const outcomes: ExploreOutcome[] = [];
    if (queue.length === 0) return outcomes;

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        for (const intent of queue) {
            const plan = await planExploration(intent, options);
            if (!plan) {
                outcomes.push({
                    requirementText: intent.requirementText,
                    factsMinted: 0,
                    covered: false,
                    executedSteps: 0,
                    failure: "no plan produced",
                });
                continue;
            }
            const context = await browser.newContext(
                options.storageStatePath ? { storageState: options.storageStatePath } : {},
            );
            const page = await context.newPage();
            try {
                const outcome = await executePlan(page, plan, intent, options);
                outcomes.push(outcome);
            } finally {
                await context.close().catch(() => undefined);
            }
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
    return outcomes;
}

/** Ask the LLM for a bounded action plan to exercise one requirement. */
async function planExploration(
    intent: IntentFact,
    options: ExplorerOptions,
): Promise<ExplorationPlan | null> {
    const routeContext = options.routes
        .slice(0, 8)
        .map((r) => {
            const forms = options.formsByRoute.get(r.path);
            const formLine = forms
                ? ` — fields [${forms.fields.map((f) => f.label).filter(Boolean).slice(0, 6).join(", ")}], submits [${forms.submits.join(", ")}]`
                : "";
            return `- ${r.path}${formLine}`;
        })
        .join("\n");

    const prompt = `You are exploring a web app at ${options.baseURL} to PROVE one requirement by exercising it in the browser.

Requirement: "${intent.requirementText}"${intent.routeHint ? `\nHints at route: ${intent.routeHint}` : ""}

Known routes and their forms:
${routeContext || "(none known)"}

Plan a bounded exploration (at most ${MAX_PLAN_STEPS} steps) using only these actions:
- {"action":"goto","target":"<route path or #/hash>"}
- {"action":"fill","target":"<input label>","value":"<text>"}
- {"action":"click","target":"<button label>"}
- {"action":"observe","target":"<short expected text to look for>"}

NEVER click anything whose label matches delete, remove, archive, sign out, logout, clear, reset, confirm, unsubscribe, place order, pay. Do not submit real orders.

Output ONLY a JSON object: {"steps":[{"action":...}]} — no prose, no fences.`;

    try {
        const result = await callWithTokenBudget({
            ai: options.ai,
            temperature: 0.3,
            invoke: (llm, timeoutMs) => llm.invoke(prompt, { timeout: timeoutMs }),
        });
        const text = extractMessageContent(result);
        return parsePlan(text);
    } catch (error) {
        console.warn("Exploration planning failed:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** Lenient JSON plan parser (reasoning models emit stray text around JSON). */
export function parsePlan(raw: string): ExplorationPlan | null {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as { steps?: unknown };
        if (!Array.isArray(parsed.steps)) return null;
        const steps: PlanStep[] = [];
        for (const rawStep of parsed.steps.slice(0, MAX_PLAN_STEPS)) {
            const step = rawStep as { action?: string; target?: string; value?: string };
            if (!["goto", "fill", "click", "observe"].includes(step.action ?? "")) continue;
            if (typeof step.target !== "string" || !step.target.trim()) continue;
            steps.push({
                action: step.action as PlanStep["action"],
                target: step.target.trim(),
                value: step.value,
            });
        }
        return steps.length > 0 ? { steps } : null;
    } catch {
        return null;
    }
}

async function executePlan(
    page: Page,
    plan: ExplorationPlan,
    intent: IntentFact,
    options: ExplorerOptions,
): Promise<ExploreOutcome> {
    let executed = 0;
    const want = tokenSet(intent.requirementText);
    try {
        for (const step of plan.steps) {
            if (DESTRUCTIVE_LABEL.test(step.target)) continue;
            let delta: string | null = null;
            if (step.action === "goto") {
                await page
                    .goto(resolveFactUrl(step.target, options.baseURL), {
                        waitUntil: "domcontentloaded",
                        timeout: 12000,
                    })
                    .catch(() => undefined);
                await page.waitForTimeout(400);
                delta = await bodyDelta(page);
            } else if (step.action === "fill") {
                // Label-based fill: prefer getByLabel, then placeholder, then
                // the first control on the page as a last resort.
                const byLabel = page.getByLabel(step.target).first();
                const byPlaceholder = page.locator(`[placeholder*="${step.target}" i]`).first();
                try {
                    if ((await byLabel.count()) > 0) {
                        await byLabel.fill(step.value ?? "test");
                    } else if ((await byPlaceholder.count()) > 0) {
                        await byPlaceholder.fill(step.value ?? "test");
                    } else {
                        await page.locator("input, select, textarea").first().fill(step.value ?? "test");
                    }
                } catch {
                    continue;
                }
                delta = await bodyDelta(page);
            } else if (step.action === "click") {
                try {
                    await page.getByRole("button", { name: new RegExp(`^${escapeRe(step.target)}$`, "i") }).first().click({ timeout: 3000 });
                } catch {
                    try {
                        await page.getByText(step.target, { exact: false }).first().click({ timeout: 3000 });
                    } catch {
                        continue;
                    }
                }
                await page.waitForTimeout(500);
                delta = await bodyDelta(page);
            } else {
                delta = await bodyDelta(page);
            }
            executed++;
            if (!delta) continue;
            // Mint a fact when the delta overlaps the requirement's tokens.
            const deltaTokens = tokenSet(delta);
            let hits = 0;
            for (const t of want) if (deltaTokens.has(t)) hits++;
            const score = want.size > 0 ? hits / want.size : 0;
            if (score >= 0.25 && delta.length > 3) {
                const evidence: FactEvidence = {
                    source: "agent",
                    capturedAt: Date.now(),
                    observedUrl: page.url(),
                    afterText: delta.slice(0, 300),
                };
                // The observable is the page line that best evidences the
                // requirement — not the first line of the page chrome.
                const best = bestMatchingLine(delta, want);
                mintObservedFact(options.store, {
                    route: page.url().replace(options.baseURL, "") || "/",
                    precondition: options.storageStatePath ? "signed in" : null,
                    action: describeStep(step),
                    expectedObservable: `shows "${best}"`,
                    evidence,
                });
            }
        }
    } catch (error) {
        return {
            requirementText: intent.requirementText,
            factsMinted: 0,
            covered: false,
            executedSteps: executed,
            failure: error instanceof Error ? error.message : String(error),
        };
    }

    // Covered? Re-check the requirement against freshly minted facts.
    const fresh = options.store
        .listBehaviorFacts("verified")
        .filter((f) => (f.evidence as FactEvidence | null)?.source === "agent");
    const covered = fresh.some((f) => matchScore(intent, f) >= 0.34);
    return {
        requirementText: intent.requirementText,
        factsMinted: fresh.length,
        covered,
        executedSteps: executed,
    };
}

async function bodyDelta(page: Page): Promise<string | null> {
    const text = await page
        .evaluate(() => document.body?.innerText?.slice(0, 1200) ?? "")
        .catch(() => "");
    return text?.trim() || null;
}

function describeStep(step: PlanStep): string {
    if (step.action === "goto") return `open ${step.target}`;
    if (step.action === "fill") return `fill ${step.target}`;
    if (step.action === "click") return `click ${step.target}`;
    return "observe";
}

/** The delta line with the highest token overlap against the requirement. */
function bestMatchingLine(delta: string, want: Set<string>): string {
    let best = "";
    let bestScore = -1;
    for (const raw of delta.split("\n")) {
        const line = raw.trim();
        if (line.length < 4 || line.length > 160) continue;
        const tokens = tokenSet(line);
        let hits = 0;
        for (const t of want) if (tokens.has(t)) hits++;
        const score = hits / Math.max(want.size, 1);
        if (score > bestScore) {
            bestScore = score;
            best = line;
        }
    }
    return (best || "page rendered").slice(0, 120);
}

function tokenSet(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 2),
    );
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
