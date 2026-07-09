/**
 * Lightweight plan preview shown before the agent acts (Claude "plan mode").
 *
 * Heuristic + site-knowledge grounded — no extra LLM round-trip. The goal is
 * to let the user confirm routes/intent before a headed browser run starts.
 */

import { loadSiteKnowledge } from "@raiken/core";
import chalk from "chalk";
import { accent, dim } from "../agent-stream";
import { extractUrl, guessIntent, matchRoutes, type PlanIntent } from "./plan-heuristics";

export interface PlanStep {
    label: string;
    detail?: string;
}

export interface AgentPlan {
    summary: string;
    intent: PlanIntent;
    steps: PlanStep[];
    routes: string[];
    warnings: string[];
}

export { extractUrl, guessIntent, matchRoutes } from "./plan-heuristics";

/**
 * Build a plan for the user's prompt using site knowledge when available.
 */
export async function buildAgentPlan(projectPath: string, prompt: string): Promise<AgentPlan> {
    const intent = guessIntent(prompt);
    const mentionedUrl = extractUrl(prompt);
    const warnings: string[] = [];
    const steps: PlanStep[] = [];
    let routes: string[] = [];

    let knowledge: Awaited<ReturnType<typeof loadSiteKnowledge>> = null;
    try {
        knowledge = await loadSiteKnowledge(projectPath);
    } catch {
        /* optional */
    }

    if (knowledge && knowledge.pagesDiscovered > 0) {
        routes = matchRoutes(prompt, knowledge.routes);
        if (mentionedUrl) {
            routes = [mentionedUrl, ...routes.filter((r) => r !== mentionedUrl)].slice(0, 5);
        }
        if (routes.length === 0 && knowledge.routes[0]) {
            routes = knowledge.routes.slice(0, 3).map((r) => r.url);
            warnings.push("No strong route match — will use top discovered pages as candidates");
        }
    } else {
        warnings.push("No site knowledge yet — run /discover <url> for better grounding");
        if (mentionedUrl) routes = [mentionedUrl];
    }

    const summary =
        intent === "generateTests"
            ? "Generate an E2E Playwright test"
            : intent === "explore"
              ? "Explore the live app in the browser"
              : intent === "explain"
                ? "Answer from code / knowledge (no browser required)"
                : "Handle the request (intent unclear — agent will classify)";

    if (intent === "explain") {
        steps.push({ label: "Search code graph / site knowledge" });
        steps.push({ label: "Answer without driving the browser" });
    } else {
        if (routes.length > 0) {
            steps.push({
                label: "Navigate to candidate route",
                detail: routes[0],
            });
        } else {
            steps.push({ label: "Resolve target URL (prompt / memory / config)" });
        }
        steps.push({ label: "Capture DOM / accessibility snapshot" });
        if (intent === "generateTests") {
            steps.push({ label: "Gather code context for the feature" });
            steps.push({ label: "Draft Playwright spec" });
            steps.push({ label: "Ask to save (unless auto-save mode)" });
        } else {
            steps.push({ label: "Explore interactive elements" });
            steps.push({ label: "Report findings" });
        }
    }

    if (knowledge?.authRequiredRoutes?.length) {
        const authHit = routes.some((r) =>
            knowledge.authRequiredRoutes.some((a) => r.includes(a) || a.includes(r)),
        );
        if (authHit) {
            warnings.push("Target may require auth — have `raiken auth` ready");
        }
    }

    return { summary, intent, steps, routes, warnings };
}

/** Print the plan card to the terminal. */
export function renderPlan(plan: AgentPlan): void {
    console.log(accent("\n  ┌─ Plan") + dim(`  ·  ${plan.intent}`));
    console.log(dim("  │ ") + chalk.white(plan.summary));
    for (const [i, step] of plan.steps.entries()) {
        console.log(
            dim("  │ ") +
                chalk.white(`${i + 1}. ${step.label}`) +
                (step.detail ? dim(`  ·  ${step.detail}`) : ""),
        );
    }
    if (plan.routes.length > 1) {
        console.log(dim("  │ candidates:"));
        for (const r of plan.routes.slice(0, 5)) {
            console.log(dim(`  │   • ${r}`));
        }
    }
    for (const w of plan.warnings) {
        console.log(dim("  │ ") + chalk.yellow(`⚠ ${w}`));
    }
    console.log(accent("  └─"));
}
