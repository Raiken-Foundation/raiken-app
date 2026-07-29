/**
 * Crawler resolution-flow tests.
 *
 * These tests target the *resolution* surface of the crawler — they
 * don't need a real browser; they exercise:
 *
 *   1. The detector pipeline framework (priority ordering, error
 *      isolation, multi-detector composition).
 *   2. The SiteKnowledgeDB resolution methods that back the dashboard's
 *      Skip / I've-handled-it / Ignore-this-kind buttons.
 *   3. The manual-fallback detector against a stubbed Page so we can
 *      assert the captcha + 5xx behavior without a Playwright instance.
 *
 * Full crawler integration (real Chromium, real network) is covered by
 * the playground runbook under "Manual Discovery Testing" in the root README.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../db";
import {
    type BlockerDetector,
    type BlockerDetectorContext,
    buildBlocker,
    createAuthDetector,
    createManualFallbackDetector,
    runBlockerPipeline,
} from "../detectors";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface FakeLocator {
    count: () => Promise<number>;
    first: () => FakeLocator;
}

function makePage(opts: { content?: string; locators?: Record<string, FakeLocator> }) {
    const locators = opts.locators ?? {};
    const empty: FakeLocator = {
        count: async () => 0,
        first() {
            return this;
        },
    };
    return {
        content: async () => opts.content ?? "<html></html>",
        locator(selector: string) {
            return locators[selector] ?? empty;
        },
    } as unknown as import("playwright").Page;
}

function makeResponse(status: number, statusText = "OK") {
    return {
        status: () => status,
        statusText: () => statusText,
    } as unknown as import("playwright").Response;
}

function makeContext(overrides: Partial<BlockerDetectorContext> = {}): BlockerDetectorContext {
    return {
        projectPath: overrides.projectPath ?? "/test/project",
        url: overrides.url ?? "http://localhost:3000",
        page: overrides.page ?? makePage({}),
        response: overrides.response,
    };
}

// ---------------------------------------------------------------------------
// Detector pipeline
// ---------------------------------------------------------------------------

describe("runBlockerPipeline", () => {
    it("runs detectors in priority order and returns the first match", async () => {
        const calls: string[] = [];
        const lo: BlockerDetector = {
            id: "lo",
            category: "captcha",
            priority: 10,
            async detect(ctx) {
                calls.push("lo");
                return buildBlocker({
                    ctx,
                    detectorId: "lo",
                    category: "captcha",
                    evidence: { from: "lo" },
                });
            },
        };
        const hi: BlockerDetector = {
            id: "hi",
            category: "auth_required",
            priority: 100,
            async detect(ctx) {
                calls.push("hi");
                return buildBlocker({
                    ctx,
                    detectorId: "hi",
                    category: "auth_required",
                    evidence: { from: "hi" },
                });
            },
        };

        const blocker = await runBlockerPipeline([hi, lo], makeContext());
        expect(blocker?.detectorId).toBe("lo");
        // The high-priority (lower number) detector won — the
        // higher-number one shouldn't have been called.
        expect(calls).toEqual(["lo"]);
    });

    it("isolates a throwing detector and continues with the next one", async () => {
        const broken: BlockerDetector = {
            id: "broken",
            category: "unknown",
            priority: 10,
            async detect() {
                throw new Error("boom");
            },
        };
        const good: BlockerDetector = {
            id: "good",
            category: "auth_required",
            priority: 20,
            async detect(ctx) {
                return buildBlocker({
                    ctx,
                    detectorId: "good",
                    category: "auth_required",
                    evidence: {},
                });
            },
        };
        const blocker = await runBlockerPipeline([broken, good], makeContext());
        expect(blocker?.detectorId).toBe("good");
    });

    it("skips ignored categories and continues to later detectors", async () => {
        const calls: string[] = [];
        const consent: BlockerDetector = {
            id: "consent",
            category: "consent_wall",
            priority: 10,
            async detect(ctx) {
                calls.push("consent");
                return buildBlocker({
                    ctx,
                    detectorId: "consent",
                    category: "consent_wall",
                    evidence: {},
                });
            },
        };
        const auth: BlockerDetector = {
            id: "auth",
            category: "auth_required",
            priority: 20,
            async detect(ctx) {
                calls.push("auth");
                return buildBlocker({
                    ctx,
                    detectorId: "auth",
                    category: "auth_required",
                    evidence: {},
                });
            },
        };

        const blocker = await runBlockerPipeline([consent, auth], makeContext(), {
            skipCategories: new Set(["consent_wall"]),
        });

        expect(blocker?.category).toBe("auth_required");
        expect(calls).toEqual(["consent", "auth"]);
    });

    it("returns null when every detector abstains", async () => {
        const a: BlockerDetector = {
            id: "a",
            category: "captcha",
            priority: 1,
            async detect() {
                return null;
            },
        };
        expect(await runBlockerPipeline([a], makeContext())).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Manual-fallback detector
// ---------------------------------------------------------------------------

describe("manual-fallback detector", () => {
    const detector = createManualFallbackDetector();

    it("flags a 502 response as an error_page blocker", async () => {
        const blocker = await detector.detect(
            makeContext({ response: makeResponse(502, "Bad Gateway") }),
        );
        expect(blocker?.category).toBe("error_page");
        expect(blocker?.detectorId).toBe("manual:error_page");
        expect(blocker?.evidenceJson).toContain("502");
    });

    it("does NOT flag a 404 response", async () => {
        const blocker = await detector.detect(
            makeContext({ response: makeResponse(404, "Not Found") }),
        );
        expect(blocker).toBeNull();
    });

    it("flags a Cloudflare Turnstile iframe as a captcha blocker", async () => {
        const turnstile: FakeLocator = {
            count: async () => 1,
            first() {
                return this;
            },
        };
        const page = makePage({
            locators: { 'iframe[src*="challenges.cloudflare.com"]': turnstile },
        });
        const blocker = await detector.detect(makeContext({ page }));
        expect(blocker?.category).toBe("captcha");
        expect(blocker?.evidenceJson).toContain("Cloudflare Turnstile");
    });

    it("returns null when neither a 5xx nor a captcha iframe is present", async () => {
        expect(await detector.detect(makeContext())).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Detector composition (auth + manual-fallback in priority order)
// ---------------------------------------------------------------------------

describe("default detector pipeline (auth + manual-fallback)", () => {
    it("manual-fallback wins over auth for a 502 response", async () => {
        // Even though 502 isn't an auth signal, the manual-fallback
        // detector has priority 50 (vs auth's 100), so it fires first.
        const detectors = [createAuthDetector(), createManualFallbackDetector()];
        const blocker = await runBlockerPipeline(
            detectors,
            makeContext({ response: makeResponse(502) }),
        );
        expect(blocker?.detectorId).toBe("manual:error_page");
    });

    it("auth wins for a 401 response (manual-fallback abstains)", async () => {
        const detectors = [createAuthDetector(), createManualFallbackDetector()];
        const blocker = await runBlockerPipeline(
            detectors,
            makeContext({ response: makeResponse(401) }),
        );
        expect(blocker?.detectorId).toBe("auth:http_status");
    });
});

// ---------------------------------------------------------------------------
// Resolution flows against the DB
// ---------------------------------------------------------------------------

describe("blocker resolution flows", () => {
    let testDir: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-resolve-"));
        db = new CodeGraphDB(testDir);
        siteDb = new SiteKnowledgeDB(db.getRawDatabase(), testDir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    function seedBlocker(category: "auth_required" | "captcha" | "manual", url: string) {
        return siteDb.saveBlocker({
            projectPath: testDir,
            url,
            category,
            severity: "pause",
            detectorId: `${category}:test`,
            detectedElements: null,
            evidenceJson: null,
            screenshotPath: null,
            resolution: null,
            resolvedVia: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });
    }

    it("clear: marks a single blocker resolved", () => {
        const id = seedBlocker("auth_required", "http://x/login");
        siteDb.markBlockerResolved(id, {
            resolution: "clear",
            resolvedVia: "dashboard",
        });
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
        const stored = siteDb.getBlocker(id);
        expect(stored?.resolution).toBe("clear");
        expect(stored?.resolvedVia).toBe("dashboard");
    });

    it("skip: marks resolved + persists the URL on the session's skip list", () => {
        const sessionId = siteDb.saveSession({
            projectPath: testDir,
            startUrl: "http://x",
            status: "paused",
            pagesDiscovered: 0,
            linksFound: 0,
            startedAt: Date.now(),
            completedAt: null,
            blockedAtUrl: "http://x/admin",
            queueJson: null,
        });

        const id = seedBlocker("auth_required", "http://x/admin");
        siteDb.updateSession(sessionId, {
            skippedUrlsJson: JSON.stringify(["http://x/admin"]),
        });
        siteDb.markBlockerResolved(id, {
            resolution: "skip",
            resolvedVia: "dashboard",
        });

        const session = siteDb.getSession(sessionId);
        expect(session?.skippedUrlsJson).toContain("http://x/admin");
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
    });

    it("ignore_category: persists the category on the session's ignore list", () => {
        const sessionId = siteDb.saveSession({
            projectPath: testDir,
            startUrl: "http://x",
            status: "paused",
            pagesDiscovered: 0,
            linksFound: 0,
            startedAt: Date.now(),
            completedAt: null,
            blockedAtUrl: null,
            queueJson: null,
        });

        const id1 = seedBlocker("captcha", "http://x/a");
        const id2 = seedBlocker("captcha", "http://x/b");

        siteDb.updateSession(sessionId, {
            ignoredCategoriesJson: JSON.stringify(["captcha"]),
        });
        // Bulk resolve every captcha row, mirroring router.continueDiscovery.
        for (const blocker of siteDb.getUnresolvedBlockers()) {
            if (blocker.category === "captcha" && blocker.id) {
                siteDb.markBlockerResolved(blocker.id, {
                    resolution: "ignore_category",
                    resolvedVia: "dashboard",
                });
            }
        }

        const session = siteDb.getSession(sessionId);
        expect(session?.ignoredCategoriesJson).toContain("captcha");
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
        expect(siteDb.getBlocker(id1)?.resolution).toBe("ignore_category");
        expect(siteDb.getBlocker(id2)?.resolution).toBe("ignore_category");
    });

    it("manual pauses stay unresolved until the user explicitly resolves them", () => {
        const id = seedBlocker("manual", "manual_pause");
        // Sweep that targets only auth blockers shouldn't touch the manual one.
        for (const blocker of siteDb.getUnresolvedBlockers()) {
            if (blocker.category === "auth_required" && blocker.id) {
                siteDb.markBlockerResolved(blocker.id, {
                    resolution: "provide_state",
                    resolvedVia: "dashboard",
                });
            }
        }
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(1);
        expect(siteDb.getBlocker(id)?.resolution).toBeNull();
    });

    it("provide_state: records the storage_state_path", () => {
        const id = seedBlocker("auth_required", "http://x/api");
        siteDb.markBlockerResolved(id, {
            resolution: "provide_state",
            resolvedVia: "dashboard",
            storageStatePath: "/tmp/auth-state.json",
        });
        const stored = siteDb.getBlocker(id);
        expect(stored?.resolution).toBe("provide_state");
        expect(stored?.storageStatePath).toBe("/tmp/auth-state.json");
    });
});
