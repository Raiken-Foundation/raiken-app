/**
 * Build short navigation flows from discovery's verified link graph so cover
 * can draft multi-step scenarios without inventing mid-flow clicks.
 */

import type { NavigationPath, PageForms } from "../site-discovery/types";
import { significantTokens } from "./intent-coverage";

export interface CoverFlowStep {
    fromUrl: string;
    toUrl: string;
    selector: string;
    linkText: string | null;
    forms?: PageForms;
}

export interface CoverFlow {
    /** Human-readable chain, e.g. "Home → Cart → Checkout". */
    label: string;
    steps: CoverFlowStep[];
    /** Selectors used along the path — treated as grounded for mid-flow clicks. */
    selectors: string[];
}

const MAX_FLOWS = 4;
const MAX_DEPTH = 3;

function pathScore(path: NavigationPath, scenarioTokens: Set<string>): number {
    let score = 0;
    const hay =
        `${path.fromUrl} ${path.toUrl} ${path.linkText ?? ""} ${path.selector}`.toLowerCase();
    for (const token of scenarioTokens) {
        if (hay.includes(token)) score += 1;
    }
    return score;
}

function chainLabel(steps: CoverFlowStep[]): string {
    const urls = [steps[0]?.fromUrl, ...steps.map((s) => s.toUrl)].filter(Boolean) as string[];
    const short = urls.map((url) => {
        try {
            const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
            return path === "/" ? "Home" : (path.split("/").filter(Boolean).slice(-1)[0] ?? path);
        } catch {
            return url;
        }
    });
    return short.join(" → ");
}

/**
 * Walk verified links into 2–4 short chains rooted at pages that match the
 * scenario. Caps depth and detects cycles.
 */
export function buildNavigationFlows(
    paths: NavigationPath[],
    scenario: string,
    formsByUrl: Map<string, PageForms | undefined> = new Map(),
): CoverFlow[] {
    if (paths.length === 0) return [];

    const scenarioTokens = new Set(significantTokens(scenario));
    const scored = [...paths]
        .map((path) => ({ path, score: pathScore(path, scenarioTokens) }))
        .sort((a, b) => b.score - a.score);

    const byFrom = new Map<string, NavigationPath[]>();
    for (const { path } of scored) {
        const list = byFrom.get(path.fromUrl) ?? [];
        list.push(path);
        byFrom.set(path.fromUrl, list);
    }

    const roots = new Set<string>();
    for (const { path, score } of scored) {
        if (score > 0 || roots.size < 3) {
            roots.add(path.fromUrl);
        }
        if (roots.size >= 6) break;
    }

    const flows: CoverFlow[] = [];
    const seenLabels = new Set<string>();

    for (const root of roots) {
        const stack: Array<{ url: string; steps: CoverFlowStep[]; visited: Set<string> }> = [
            { url: root, steps: [], visited: new Set([root]) },
        ];

        while (stack.length > 0 && flows.length < MAX_FLOWS) {
            const current = stack.pop();
            if (!current) break;
            const outgoing = byFrom.get(current.url) ?? [];
            for (const link of outgoing) {
                if (current.visited.has(link.toUrl)) continue;
                const step: CoverFlowStep = {
                    fromUrl: link.fromUrl,
                    toUrl: link.toUrl,
                    selector: link.selector,
                    linkText: link.linkText,
                    ...(formsByUrl.get(link.toUrl) ? { forms: formsByUrl.get(link.toUrl) } : {}),
                };
                const nextSteps = [...current.steps, step];
                if (nextSteps.length >= 1) {
                    const flow: CoverFlow = {
                        label: chainLabel(nextSteps),
                        steps: nextSteps,
                        selectors: nextSteps.map((s) => s.selector).filter(Boolean),
                    };
                    if (!seenLabels.has(flow.label) && nextSteps.length >= 1) {
                        seenLabels.add(flow.label);
                        flows.push(flow);
                    }
                }
                if (nextSteps.length < MAX_DEPTH) {
                    stack.push({
                        url: link.toUrl,
                        steps: nextSteps,
                        visited: new Set([...current.visited, link.toUrl]),
                    });
                }
                if (flows.length >= MAX_FLOWS) break;
            }
        }
        if (flows.length >= MAX_FLOWS) break;
    }

    // Prefer longer chains and higher scenario overlap.
    return flows
        .sort((a, b) => {
            const scoreA = a.steps.reduce(
                (sum, step) =>
                    sum +
                    pathScore(
                        {
                            fromUrl: step.fromUrl,
                            toUrl: step.toUrl,
                            selector: step.selector,
                            linkText: step.linkText,
                            verified: true,
                        },
                        scenarioTokens,
                    ),
                0,
            );
            const scoreB = b.steps.reduce(
                (sum, step) =>
                    sum +
                    pathScore(
                        {
                            fromUrl: step.fromUrl,
                            toUrl: step.toUrl,
                            selector: step.selector,
                            linkText: step.linkText,
                            verified: true,
                        },
                        scenarioTokens,
                    ),
                0,
            );
            return scoreB - scoreA || b.steps.length - a.steps.length;
        })
        .slice(0, MAX_FLOWS);
}

/** Render flows for the cover prompt. */
export function formatNavigationFlows(flows: CoverFlow[]): string {
    if (flows.length === 0) return "";
    const lines: string[] = [
        "[KNOWN NAVIGATION PATHS — click these selectors mid-flow; do not page.goto between steps]",
    ];
    for (const flow of flows) {
        lines.push(`Flow: ${flow.label}`);
        for (const step of flow.steps) {
            const via = step.linkText ? `"${step.linkText}" via ${step.selector}` : step.selector;
            lines.push(`  ${step.fromUrl} → ${step.toUrl}  (${via})`);
        }
    }
    return lines.join("\n");
}
