/**
 * Permanent regression gates for the accuracy remediation (batches 1–4),
 * measured against the deterministic `tools/playground-auth` benchmark.
 *
 * Each fixed failure gets a scenario here so it cannot regress silently. Unit
 * tests already pin the decision functions; what they structurally cannot show
 * is whether the whole pipeline still behaves against a real browser and a real
 * app — which is exactly where every one of these bugs was found.
 *
 * No LLM key is required. Every scenario exercises crawler, browser, and
 * grounding code paths whose outcome is fully determined by the fixture, so a
 * failure here is a real regression rather than model variance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    type AuthPrecondition,
    resolveAuthPrecondition,
    shouldUseStorageState,
} from "../../agent/graph/utils";
import { validateSelectorGrounding } from "../../agent/grounding";
import { formatDOMContext } from "../../browser/dom-capture";
import { BrowserSession } from "../../browser/session";
import { CodeGraphDB } from "../../database/db";
import { SiteDiscovery } from "../../site-discovery/crawler";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import type { BlockerCategory, DiscoveredPage, DiscoveryBlocker } from "../../site-discovery/types";
import { atLeast, scorer } from "../scorers";
import { commandTarget } from "../targets";
import type { EvalAttemptContext, EvalScenario, EvalTarget } from "../types";

export interface BenchmarkEvalOptions {
    /** Repo-relative or absolute path to `tools/playground-auth`. */
    authPlaygroundDir: string;
}

/**
 * Routes the fixture puts behind its auth middleware. Recall against this list
 * is the "authenticated discovery finds the whole app" gate — a crawl that
 * comes back with a subset means the post-login link graph was not walked.
 */
export const PROTECTED_ROUTES = ["/dashboard", "/projects", "/tasks", "/settings", "/members"];

/**
 * The fixture's session cookie is base64 JSON, readable by
 * `tools/playground-auth/auth-server.ts`. Building it here (rather than driving
 * a login) keeps the authenticated scenarios deterministic and fast: no form
 * interaction, no MFA branch, no dependence on the login page rendering.
 *
 * Mirrors `SessionPayload` in `tools/playground-auth/src/auth/fixture.ts`.
 */
export function buildFixtureStorageState(baseUrl: string): string {
    const payload = {
        user: "admin",
        name: "Admin User",
        role: "admin",
        permissions: ["manage:workspace", "manage:projects", "manage:members"],
        exp: Date.now() + 86_400_000,
    };
    const { hostname } = new URL(baseUrl);
    return JSON.stringify({
        cookies: [
            {
                name: "raiken-session",
                value: Buffer.from(JSON.stringify(payload)).toString("base64"),
                domain: hostname,
                path: "/",
                expires: Math.floor(payload.exp / 1000),
                httpOnly: true,
                secure: false,
                sameSite: "Lax",
            },
        ],
        origins: [
            {
                origin: baseUrl,
                // Dismiss the cookie banner. It is a bottom-anchored,
                // non-blocking notice, but leaving it up puts a fixed element
                // over controls at the bottom of a page.
                localStorage: [{ name: "playground-auth-cookie-consent", value: "accepted" }],
            },
        ],
    });
}

/** Write the fixture's authenticated state into the attempt's sandbox. */
function writeStorageState(ctx: EvalAttemptContext, baseUrl: string): string {
    const statePath = path.join(ctx.workDir, "auth-state.json");
    fs.writeFileSync(statePath, buildFixtureStorageState(baseUrl));
    return statePath;
}

/**
 * The full fixture — React SPA plus the NextAuth-style middleware that issues
 * sessions, gates routes, and drives MFA. The middleware is installed by
 * `configureServer`, so only the dev server has it; the built bundle in `dist`
 * would serve every protected route unguarded.
 */
function fixtureTarget(authDir: string): EvalTarget {
    return commandTarget({
        name: "playground-auth (full fixture)",
        command: process.execPath,
        args: [
            path.join(authDir, "node_modules", "vite", "bin", "vite.js"),
            "--port",
            "{port}",
            "--strictPort",
            "--host",
            "127.0.0.1",
        ],
        cwd: authDir,
        // Vite has to cold-start and pre-bundle deps on a clean checkout.
        readyTimeoutMs: 60_000,
    });
}

interface CrawlSnapshot {
    pages: DiscoveredPage[];
    blockers: DiscoveryBlocker[];
    allBlockers: DiscoveryBlocker[];
}

function readSnapshot(workDir: string): CrawlSnapshot {
    const db = new CodeGraphDB(workDir);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), workDir);
        return {
            pages: siteDb.getAllPages(),
            blockers: siteDb.getUnresolvedBlockers(),
            allBlockers: siteDb.getAllBlockers(),
        };
    } finally {
        db.close();
    }
}

function routePaths(pages: DiscoveredPage[]): string[] {
    return pages.map((page) => {
        try {
            return new URL(page.url).pathname.replace(/\/$/, "") || "/";
        } catch {
            return page.url;
        }
    });
}

function categories(blockers: DiscoveryBlocker[]): string[] {
    return blockers.map((blocker) => blocker.category);
}

/**
 * Apply the dashboard's "Ignore this kind" resolution exactly as
 * `router.continueDiscovery` does: record the category on the session so the
 * detector pipeline skips it after the resume, and bulk-resolve every row in
 * that category so the next pass can't immediately re-pause on a sibling.
 */
function ignoreCategory(workDir: string, category: BlockerCategory): void {
    const db = new CodeGraphDB(workDir);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), workDir);
        const session = siteDb.getActiveSession();
        if (!session?.id) throw new Error("no active discovery session to resume");

        const existing = session.ignoredCategoriesJson
            ? (JSON.parse(session.ignoredCategoriesJson) as string[])
            : [];
        siteDb.updateSession(session.id, {
            ignoredCategoriesJson: JSON.stringify([...new Set([...existing, category])]),
        });

        for (const blocker of siteDb.getUnresolvedBlockers()) {
            if (blocker.category === category && blocker.id) {
                siteDb.markBlockerResolved(blocker.id, {
                    resolution: "ignore_category",
                    resolvedVia: "dashboard",
                });
            }
        }
    } finally {
        db.close();
    }
}

interface CrawlOutcome {
    status: string;
    pagesDiscovered: number;
    /** Message of a thrown crawl failure, e.g. the zero-page guard. */
    error: string | null;
}

async function crawl(
    ctx: EvalAttemptContext,
    options: {
        maxPages: number;
        storageStatePath?: string | null;
        continueSession?: boolean;
    },
): Promise<CrawlOutcome> {
    if (!ctx.baseUrl) throw new Error("scenario requires a target");

    const discovery = new SiteDiscovery({
        startUrl: ctx.baseUrl,
        projectPath: ctx.workDir,
        maxPages: options.maxPages,
        maxDepth: 3,
        maxConcurrency: 2,
        timeout: 15_000,
        pauseOnAuth: true,
        storageStatePath: options.storageStatePath ?? null,
        continueSession: options.continueSession ?? false,
        maxRunTimeMs: 120_000,
    });

    let error: string | null = null;
    try {
        await discovery.start();
    } catch (crawlError) {
        error = crawlError instanceof Error ? crawlError.message : String(crawlError);
    } finally {
        await discovery.close();
    }

    const stats = discovery.getStats();
    return { status: stats.status, pagesDiscovered: stats.pagesDiscovered, error };
}

// ── Scenario 1: consent must not mask the auth wall ─────────────────────────

interface ConsentOutput extends CrawlSnapshot {
    outcome: CrawlOutcome;
}

function consentOverAuthScenario(authDir: string): EvalScenario<ConsentOutput> {
    return {
        id: "benchmark-consent-over-auth",
        description:
            "Unauthenticated discovery of the full fixture must report the underlying " +
            "auth wall, not the non-blocking cookie banner sitting on top of it.",
        createTarget: () => fixtureTarget(authDir),
        run: async (ctx) => {
            const outcome = await crawl(ctx, { maxPages: 6 });
            return { ...readSnapshot(ctx.workDir), outcome };
        },
        scorers: [
            atLeast(
                "surfaces-auth-required",
                1,
                (output) =>
                    output.allBlockers.filter((blocker) => blocker.category === "auth_required")
                        .length,
            ),
            scorer("cookie-banner-is-not-a-wall", (output) => {
                const consent = output.allBlockers.filter(
                    (blocker) => blocker.category === "consent_wall",
                );
                return {
                    passed: consent.length === 0,
                    value: consent.length,
                    detail: `blockers: ${categories(output.allBlockers).join(", ") || "none"}`,
                };
            }),
            scorer("pauses-instead-of-reporting-an-empty-success", (output) => {
                const falseSuccess =
                    output.outcome.status === "completed" && output.outcome.pagesDiscovered === 0;
                return {
                    passed: !falseSuccess,
                    detail: `status ${output.outcome.status}, ${output.outcome.pagesDiscovered} page(s)`,
                };
            }),
        ],
    };
}

// ── Scenario 2: ignoring a category lets the crawl continue ─────────────────

interface IgnoreCategoryOutput {
    first: CrawlOutcome;
    firstBlockers: string[];
    resumed: CrawlOutcome;
    resumedPages: string[];
    unresolvedAfter: string[];
}

function ignoreCategoryScenario(authDir: string): EvalScenario<IgnoreCategoryOutput> {
    return {
        id: "benchmark-ignore-category-continuation",
        description:
            "Pausing on the auth wall, ignoring that category, and continuing must crawl " +
            "the pages the wall was hiding instead of finishing empty or re-pausing.",
        createTarget: () => fixtureTarget(authDir),
        run: async (ctx) => {
            const first = await crawl(ctx, { maxPages: 6 });
            const firstSnapshot = readSnapshot(ctx.workDir);

            ignoreCategory(ctx.workDir, "auth_required");

            ctx.log("resuming with auth_required ignored…");
            const resumed = await crawl(ctx, { maxPages: 6, continueSession: true });
            const resumedSnapshot = readSnapshot(ctx.workDir);

            return {
                first,
                firstBlockers: categories(firstSnapshot.allBlockers),
                resumed,
                resumedPages: routePaths(resumedSnapshot.pages),
                unresolvedAfter: categories(resumedSnapshot.blockers),
            };
        },
        scorers: [
            scorer("first-pass-pauses-on-the-wall", (output) => ({
                passed:
                    output.first.status === "paused" &&
                    output.first.error === null &&
                    output.firstBlockers.includes("auth_required"),
                detail: `status ${output.first.status}, blockers: ${
                    output.firstBlockers.join(", ") || "none"
                }`,
            })),
            atLeast("resume-discovers-pages", 1, (output) => output.resumedPages.length),
            scorer("resume-never-claims-an-empty-success", (output) => {
                const falseSuccess =
                    output.resumed.status === "completed" && output.resumed.pagesDiscovered === 0;
                return {
                    passed: !falseSuccess,
                    detail: `status ${output.resumed.status}, pages: ${
                        output.resumedPages.join(", ") || "none"
                    }`,
                };
            }),
            scorer("ignored-category-stays-resolved", (output) => ({
                passed: !output.unresolvedAfter.includes("auth_required"),
                detail: `unresolved after resume: ${output.unresolvedAfter.join(", ") || "none"}`,
            })),
        ],
    };
}

// ── Scenario 3: authenticated route recall ──────────────────────────────────

interface RecallOutput {
    outcome: CrawlOutcome;
    paths: string[];
    blockers: string[];
}

function authenticatedRecallScenario(authDir: string): EvalScenario<RecallOutput> {
    return {
        id: "benchmark-authenticated-recall",
        description:
            "With the fixture's admin session supplied as storage state, discovery must " +
            "reach every protected route class rather than stopping at the login redirect.",
        createTarget: () => fixtureTarget(authDir),
        run: async (ctx) => {
            if (!ctx.baseUrl) throw new Error("scenario requires a target");
            const storageStatePath = writeStorageState(ctx, ctx.baseUrl);
            const outcome = await crawl(ctx, { maxPages: 20, storageStatePath });
            const snapshot = readSnapshot(ctx.workDir);
            return {
                outcome,
                paths: routePaths(snapshot.pages),
                blockers: categories(snapshot.allBlockers),
            };
        },
        scorers: [
            scorer("finds-every-protected-route", (output) => {
                const found = new Set(output.paths);
                const missing = PROTECTED_ROUTES.filter((route) => !found.has(route));
                return {
                    passed: missing.length === 0,
                    value: PROTECTED_ROUTES.length - missing.length,
                    detail:
                        missing.length === 0
                            ? `found ${[...found].sort().join(", ")}`
                            : `missing ${missing.join(", ")} (found ${[...found].sort().join(", ")})`,
                };
            }),
            scorer("walks-into-a-project-detail-page", (output) => {
                const detail = output.paths.filter((route) => /^\/projects\/[^/]+$/.test(route));
                return {
                    passed: detail.length > 0,
                    value: detail.length,
                    detail: detail.join(", ") || "no /projects/:id page discovered",
                };
            }),
            scorer("authenticated-crawl-hits-no-auth-wall", (output) => {
                const auth = output.blockers.filter((category) => category === "auth_required");
                return {
                    passed: auth.length === 0,
                    value: auth.length,
                    detail: `blockers: ${output.blockers.join(", ") || "none"}`,
                };
            }),
        ],
    };
}

// ── Scenario 4: modal landmarks and grounded selectors ──────────────────────

interface GroundingOutput {
    landmarks: Array<{ role: string; name: string }>;
    /** Kinds reported for the role-mismatched locator. */
    contradictionKinds: string[];
    suggestion: string | undefined;
    /** True when the correct locator produced no contradiction. */
    correctLocatorIsClean: boolean;
    /** Contradictions the hand-written golden suite produces (must be zero). */
    goldenContradictions: string[];
}

const WRONG_MODAL_LOCATOR =
    "await expect(page.getByRole('dialog', { name: 'Delete workspace' })).toBeVisible();";
const CORRECT_MODAL_LOCATOR =
    "await expect(page.getByRole('alertdialog', { name: 'Delete workspace?' })).toBeVisible();";

function modalGroundingScenario(authDir: string): EvalScenario<GroundingOutput> {
    const goldenSuitePath = path.join(authDir, "tests", "auth-flow.spec.ts");

    return {
        id: "benchmark-modal-grounding",
        description:
            "Capture the fixture's destructive-confirmation modal and verify grounding " +
            "blocks the dialog/alertdialog role mismatch while leaving correct tests alone.",
        createTarget: () => fixtureTarget(authDir),
        run: async (ctx) => {
            if (!ctx.baseUrl) throw new Error("scenario requires a target");
            const storageStatePath = writeStorageState(ctx, ctx.baseUrl);

            const session = BrowserSession.__create(ctx.workDir, { headless: true });
            let summary: string;
            let landmarks: Array<{ role: string; name: string }>;
            try {
                await session.start({ headless: true, storageStatePath });
                await session.navigate(`${ctx.baseUrl}/settings`);
                await session.click("getByTestId('delete-workspace')");
                const dom = await session.captureCurrentPage();
                summary = formatDOMContext(dom);
                landmarks = dom.interactiveElements
                    .filter((el) => el.role === "dialog" || el.role === "alertdialog")
                    .map((el) => ({ role: el.role ?? "", name: el.name ?? "" }));
            } finally {
                await session.close();
            }

            const mismatch = validateSelectorGrounding(WRONG_MODAL_LOCATOR, [summary]);
            const correct = validateSelectorGrounding(CORRECT_MODAL_LOCATOR, [summary]);
            const golden = fs.existsSync(goldenSuitePath)
                ? validateSelectorGrounding(fs.readFileSync(goldenSuitePath, "utf-8"), [summary])
                : null;

            return {
                landmarks,
                contradictionKinds: mismatch.contradictions.map((violation) => violation.kind),
                suggestion: mismatch.contradictions[0]?.suggestion,
                correctLocatorIsClean: correct.contradictions.length === 0,
                goldenContradictions:
                    golden?.contradictions.map((violation) => violation.locator) ?? [],
            };
        },
        scorers: [
            scorer("captures-the-alertdialog-landmark", (output) => {
                const modal = output.landmarks.find((el) => el.role === "alertdialog");
                return {
                    passed: modal?.name === "Delete workspace?",
                    detail: modal
                        ? `${modal.role} named "${modal.name}"`
                        : `no modal landmark captured (saw: ${
                              output.landmarks.map((el) => el.role).join(", ") || "none"
                          })`,
                };
            }),
            scorer("role-mismatch-is-a-contradiction", (output) => ({
                passed:
                    output.contradictionKinds.length === 1 &&
                    output.contradictionKinds[0] === "role_mismatch" &&
                    output.suggestion?.includes("alertdialog") === true,
                detail: `kinds: ${output.contradictionKinds.join(", ") || "none"}; suggestion: ${
                    output.suggestion ?? "none"
                }`,
            })),
            scorer("correct-locator-validates-clean", (output) => ({
                passed: output.correctLocatorIsClean,
                detail: output.correctLocatorIsClean
                    ? undefined
                    : "the grounded alertdialog locator was reported as a contradiction",
            })),
            scorer("golden-suite-has-no-false-contradictions", (output) => ({
                passed: output.goldenContradictions.length === 0,
                value: output.goldenContradictions.length,
                detail: output.goldenContradictions.join("; ") || "none",
            })),
        ],
    };
}

// ── Scenario 5: auth preconditions for generation ───────────────────────────

export interface PreconditionCase {
    prompt: string;
    expected: AuthPrecondition;
}

/**
 * Prompts covering every auth shape the benchmark exposes. The MFA and
 * credential rows are the regression that started this: they resolved to
 * `authenticated`, so generation injected `storageState` and the test opened
 * an already-signed-in app with no login form to drive.
 */
export const PRECONDITION_CASES: PreconditionCase[] = [
    { prompt: "test the MFA verification code prompt for mfa-admin", expected: "login_flow" },
    { prompt: "test signing in with invalid credentials", expected: "login_flow" },
    { prompt: "test the sign-in flow for a locked account", expected: "login_flow" },
    { prompt: "verify the login page renders while logged out", expected: "unauthenticated" },
    { prompt: "check the unauthenticated landing experience", expected: "unauthenticated" },
    {
        prompt: "delete the workspace from settings as an authenticated admin",
        expected: "authenticated",
    },
    { prompt: "add a task on the tasks page", expected: "authenticated" },
];

export interface PreconditionResult extends PreconditionCase {
    actual: AuthPrecondition;
    usesStorageState: boolean;
}

export function evaluatePreconditionCases(cases: PreconditionCase[]): PreconditionResult[] {
    return cases.map((testCase) => {
        const actual = resolveAuthPrecondition({ userPrompt: testCase.prompt });
        return { ...testCase, actual, usesStorageState: shouldUseStorageState(actual) };
    });
}

function preconditionScenario(): EvalScenario<PreconditionResult[]> {
    return {
        id: "benchmark-auth-precondition",
        description:
            "Every benchmark auth prompt must resolve to the precondition its test needs, " +
            "and only an authenticated one may inherit saved storage state.",
        run: () => Promise.resolve(evaluatePreconditionCases(PRECONDITION_CASES)),
        scorers: [
            scorer("resolves-the-expected-precondition", (results) => {
                const wrong = results.filter((result) => result.actual !== result.expected);
                return {
                    passed: wrong.length === 0,
                    value: results.length - wrong.length,
                    detail:
                        wrong
                            .map((r) => `"${r.prompt}" → ${r.actual} (expected ${r.expected})`)
                            .join("; ") || `${results.length} prompts correct`,
                };
            }),
            scorer("login-flows-never-inherit-storage-state", (results) => {
                const leaked = results.filter(
                    (result) => result.expected !== "authenticated" && result.usesStorageState,
                );
                return {
                    passed: leaked.length === 0,
                    value: leaked.length,
                    detail: leaked.map((r) => `"${r.prompt}"`).join("; ") || "none",
                };
            }),
        ],
    };
}

export function buildBenchmarkScenarios(
    options: BenchmarkEvalOptions,
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous scenario outputs; each is internally type-safe
): Array<EvalScenario<any>> {
    const authDir = path.resolve(options.authPlaygroundDir);
    if (!fs.existsSync(path.join(authDir, "auth-server.ts"))) {
        throw new Error(
            `Benchmark evals: playground-auth fixture not found at ${authDir}. ` +
                "Run from the raiken repo root, or pass --dir.",
        );
    }
    if (!fs.existsSync(path.join(authDir, "node_modules", "vite", "bin", "vite.js"))) {
        throw new Error(
            `Benchmark evals: ${authDir} has no installed vite — run pnpm install first.`,
        );
    }

    return [
        consentOverAuthScenario(authDir),
        ignoreCategoryScenario(authDir),
        authenticatedRecallScenario(authDir),
        modalGroundingScenario(authDir),
        preconditionScenario(),
    ];
}
