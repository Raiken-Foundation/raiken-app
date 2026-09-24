/**
 * Ground-truth eval scenarios against the repo's fixture apps
 * (`tools/playground-notes`, `tools/playground-tasks`). These are the CI-able
 * regression checks for agent-adjacent behavior that unit tests structurally
 * miss — "does discovery actually walk the SPA", "does an auth wall produce
 * a blocker handoff instead of a garbage crawl".
 *
 * No LLM key required: both scenarios exercise the crawler + detector
 * pipeline only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CodeGraphDB } from "../../database/db";
import { SiteDiscovery } from "../../site-discovery/crawler";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import type { DiscoveredPage, DiscoveryBlocker } from "../../site-discovery/types";
import { atLeast, scorer } from "../scorers";
import { commandTarget, staticSpaTarget } from "../targets";
import type { EvalAttemptContext, EvalScenario } from "../types";

export interface PlaygroundEvalOptions {
    /** Repo-relative or absolute path to tools/playground-notes. */
    notesDir: string;
    /** Repo-relative or absolute path to tools/playground-tasks. */
    tasksDir: string;
}

interface DiscoveryEvalOutput {
    pages: DiscoveredPage[];
    blockers: DiscoveryBlocker[];
}

/**
 * Crawl `baseUrl` with the temp workDir as the project (so all persisted
 * state lands in the attempt's sandbox), then read back what was saved.
 */
async function crawlAndCollect(
    ctx: EvalAttemptContext,
    options: { maxPages: number; pauseOnAuth: boolean },
): Promise<DiscoveryEvalOutput> {
    if (!ctx.baseUrl) throw new Error("scenario requires a target");

    const discovery = new SiteDiscovery({
        startUrl: ctx.baseUrl,
        projectPath: ctx.workDir,
        maxPages: options.maxPages,
        maxDepth: 3,
        maxConcurrency: 2,
        timeout: 10_000,
        pauseOnAuth: options.pauseOnAuth,
        maxRunTimeMs: 90_000,
    });
    try {
        await discovery.start();
    } finally {
        await discovery.close();
    }

    const db = new CodeGraphDB(ctx.workDir);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), ctx.workDir);
        return { pages: siteDb.getAllPages(), blockers: siteDb.getUnresolvedBlockers() };
    } finally {
        db.close();
    }
}

function pagePaths(output: DiscoveryEvalOutput): string[] {
    return output.pages.map((page) => {
        try {
            return new URL(page.url).pathname.replace(/\/$/, "") || "/";
        } catch {
            return page.url;
        }
    });
}

export function buildPlaygroundScenarios(
    options: PlaygroundEvalOptions,
): Array<EvalScenario<DiscoveryEvalOutput>> {
    const notesDist = path.join(path.resolve(options.notesDir), "dist");
    const tasksDir = path.resolve(options.tasksDir);

    const discoveryScenario: EvalScenario<DiscoveryEvalOutput> = {
        id: "playground-discovery",
        description:
            "Crawl the notes SPA and verify the link-reachable public route graph is " +
            "discovered (/, /about, /login — /archive exists as a route but is never linked).",
        createTarget: () => staticSpaTarget({ name: "playground-notes", distDir: notesDist }),
        // pauseOnAuth false: reaching the login page must not halt a crawl of
        // the PUBLIC graph — that's exactly the behavior the auth-wall
        // scenario below asserts separately.
        run: (ctx) => crawlAndCollect(ctx, { maxPages: 10, pauseOnAuth: false }),
        scorers: [
            atLeast("finds-public-pages", 2, (output) => output.pages.length),
            scorer("finds-known-routes", (output) => {
                const paths = new Set(pagePaths(output));
                const expected = ["/", "/about"];
                const missing = expected.filter((route) => !paths.has(route));
                return {
                    passed: missing.length === 0,
                    detail:
                        missing.length === 0
                            ? `found ${[...paths].sort().join(", ")}`
                            : `missing ${missing.join(", ")} (found ${[...paths].sort().join(", ")})`,
                };
            }),
            scorer("login-surfaces-as-blocker-not-page", (output) => {
                // The crawler deliberately records login pages as auth
                // blockers instead of content pages — assert the /login
                // route surfaced through one of the two channels.
                const asPage = pagePaths(output).includes("/login");
                const asBlocker = output.blockers.some((blocker) => blocker.url.includes("/login"));
                return {
                    passed: asPage || asBlocker,
                    detail: `page: ${asPage}, blocker: ${asBlocker} (blockers: ${
                        output.blockers.map((blocker) => blocker.url).join(", ") || "none"
                    })`,
                };
            }),
            scorer("pages-have-titles", (output) => {
                const untitled = output.pages.filter((page) => !page.title?.trim());
                return {
                    passed: untitled.length === 0,
                    value: untitled.length,
                    detail: untitled.length > 0 ? `untitled: ${untitled[0]?.url}` : undefined,
                };
            }),
        ],
    };

    const authScenario: EvalScenario<DiscoveryEvalOutput> = {
        id: "playground-auth-wall",
        description:
            "Crawl the task manager's middleware fixture and verify the auth wall is detected " +
            "as an auth_required blocker (handoff) instead of a garbage crawl.",
        createTarget: () =>
            commandTarget({
                name: "playground-tasks",
                command: process.execPath,
                args: [path.join(tasksDir, "server.mjs"), "{port}"],
                cwd: tasksDir,
            }),
        run: (ctx) => crawlAndCollect(ctx, { maxPages: 10, pauseOnAuth: true }),
        scorers: [
            atLeast(
                "detects-auth-blocker",
                1,
                (output) =>
                    output.blockers.filter((blocker) => blocker.category === "auth_required")
                        .length,
            ),
            scorer("does-not-crawl-behind-wall", (output) => {
                // Everything reachable unauthenticated is the login flow;
                // discovering many "pages" means the wall wasn't recognized.
                return {
                    passed: output.pages.length <= 3,
                    value: output.pages.length,
                    detail: `pages saved: ${pagePaths(output).join(", ") || "(none)"}`,
                };
            }),
        ],
    };

    // Fail fast with a clear message when the fixtures aren't built/present.
    for (const [label, dir] of [
        ["playground-notes dist", notesDist],
        ["playground-tasks", tasksDir],
    ] as const) {
        if (!fs.existsSync(dir)) {
            throw new Error(
                `Playground evals: ${label} not found at ${dir}. ` +
                    "Run from the raiken repo root (or pass --dir), and build the fixtures first.",
            );
        }
    }

    return [discoveryScenario, authScenario];
}
