/**
 * Unit tests for the crawl page processor's policy layer: logout-URL
 * navigation guard, per-run counter parity with the persisted row counts,
 * and the public-login-page downgrade for authenticated crawls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../link-extraction", () => ({
    extractLinksFromPage: vi.fn(async () => []),
}));
vi.mock("../form-extractor", () => ({
    extractPageForms: vi.fn(async () => null),
}));

import type { BlockerDetector } from "../../detectors";
import type { BlockerCategory, DiscoveryBlocker, DiscoveryStats } from "../../types";
import { extractLinksFromPage } from "../link-extraction";
import { type CrawlPageProcessorDeps, createCrawlPageProcessor } from "../request-handler";
import type { PlaywrightStorageState } from "../types";

const START_URL = "http://app.local";
const STORAGE_STATE: PlaywrightStorageState = { cookies: [], origins: [] };

function makeStats(): DiscoveryStats {
    return {
        pagesDiscovered: 0,
        linksFound: 0,
        authBlockersFound: 0,
        currentDepth: 0,
        currentUrl: null,
        status: "running",
        startedAt: Date.now(),
        elapsedMs: 0,
    };
}

function makePage(title = "Page", snapshot: string | null = "- heading: Sign in") {
    return {
        waitForLoadState: vi.fn(async () => {}),
        locator: () => ({ ariaSnapshot: vi.fn(async () => snapshot) }),
        title: vi.fn(async () => title),
    };
}

function makeDeps(overrides: Partial<CrawlPageProcessorDeps> = {}) {
    const stats = makeStats();
    const siteDb = {
        getPage: vi.fn(() => null),
        savePage: vi.fn(() => 1),
        updatePageContent: vi.fn(),
        getPendingLinksTo: vi.fn(() => []),
        updateLinkStatus: vi.fn(),
        saveLink: vi.fn(() => 1),
        saveBlocker: vi.fn(() => 42),
        updateSession: vi.fn(),
    };
    const requestQueue = { addRequests: vi.fn(async () => ({})) };
    const pause = vi.fn(async () => {});
    const emit = vi.fn(() => true);
    const hasSeenAuthenticatedSuccess = { current: false };

    const deps: CrawlPageProcessorDeps = {
        options: {
            startUrl: START_URL,
            projectPath: "/p",
            maxPages: 100,
            maxDepth: 5,
            maxConcurrency: 3,
            timeout: 30_000,
            excludePatterns: [],
            pauseOnAuth: true,
            storageStatePath: null,
            continueSession: false,
            purgeQueueOnResume: false,
            maxRunTimeMs: 0,
            preserveQueryParams: false,
        },
        stats,
        siteDb: siteDb as never,
        getSessionId: () => 7,
        getRequestQueue: () => requestQueue as never,
        getStartOrigin: () => "http://app.local",
        visitedUrls: new Set<string>(),
        inFlightUrls: new Set<string>(),
        committedUrls: new Set<string>(),
        pendingRequests: new Map(),
        skippedUrls: new Set<string>(),
        ignoredCategories: new Set<BlockerCategory>(),
        detectors: [],
        playwrightStorageState: null,
        hasSeenAuthenticatedSuccess,
        resolvedLoginShapedUrls: new Set<string>(),
        snapshotFailureReports: { count: 0 },
        handlerInvoked: { current: false },
        isPaused: () => false,
        excludeMatchers: [],
        normalizeUrl: (url: string) => {
            const u = new URL(url);
            return `${u.origin}${u.pathname}`.replace(/\/$/, "") || u.origin;
        },
        pause,
        emit,
        recordFailure: vi.fn(),
        ...overrides,
    };

    return { deps, stats, siteDb, requestQueue, pause, emit, hasSeenAuthenticatedSuccess };
}

function contextFor(url: string, page: unknown, response?: unknown) {
    return {
        page,
        request: { url, userData: { depth: 0, parentUrl: null } },
        response,
    } as never;
}

function authBlocker(url: string, detectorId: string): DiscoveryBlocker {
    return {
        projectPath: "/p",
        url,
        category: "auth_required",
        severity: "pause",
        detectorId,
        detectedElements: null,
        evidenceJson: null,
        screenshotPath: null,
        resolution: null,
        resolvedVia: null,
        resolvedAt: null,
        storageStatePath: null,
        discoveredAt: Date.now(),
    };
}

function authDetectorReturning(blocker: DiscoveryBlocker | null): BlockerDetector {
    return {
        id: "auth",
        category: "auth_required",
        priority: 100,
        detect: async () => blocker,
    };
}

const mockedExtractLinks = vi.mocked(extractLinksFromPage);

beforeEach(() => {
    mockedExtractLinks.mockReset();
    mockedExtractLinks.mockResolvedValue([]);
});

describe("logout navigation guard", () => {
    it("records logout links but never enqueues them while a session is loaded", async () => {
        mockedExtractLinks.mockResolvedValue([
            { href: "/logout", text: "Log out", dataTestId: null, tagName: "a", role: "link" },
            { href: "/about", text: "About", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const { deps, siteDb, requestQueue } = makeDeps({
            playwrightStorageState: STORAGE_STATE,
        });
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/`, makePage()));

        // Both links are recorded as discovered structure...
        const savedTargets = siteDb.saveLink.mock.calls.map((c) => c[0].toUrl);
        expect(savedTargets).toContain(`${START_URL}/logout`);
        expect(savedTargets).toContain(`${START_URL}/about`);

        // ...but only the safe one is ever scheduled for navigation.
        expect(requestQueue.addRequests).toHaveBeenCalledTimes(1);
        const enqueued = requestQueue.addRequests.mock.calls[0][0].map(
            (r: { url: string }) => r.url,
        );
        expect(enqueued).toEqual([`${START_URL}/about`]);
        // And the logout URL is not held in the resume queue either.
        expect([...deps.pendingRequests.values()].map((r) => r.url)).toEqual([
            `${START_URL}/about`,
        ]);
    });

    it("still enqueues logout links when no storage state is loaded", async () => {
        mockedExtractLinks.mockResolvedValue([
            { href: "/logout", text: "Log out", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const { deps, requestQueue } = makeDeps({ playwrightStorageState: null });
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/`, makePage()));

        const enqueued = requestQueue.addRequests.mock.calls[0][0].map(
            (r: { url: string }) => r.url,
        );
        expect(enqueued).toEqual([`${START_URL}/logout`]);
    });
});

describe("per-run counter parity with persisted rows", () => {
    it("counts a page once per run even when committed twice (redirect then direct)", async () => {
        const { deps, stats, siteDb } = makeDeps();
        siteDb.getPage
            .mockReturnValueOnce(null) // first commit: fresh row
            .mockReturnValue({ id: 1, url: `${START_URL}/shared` } as never); // then refresh
        const handle = createCrawlPageProcessor(deps);

        const redirectResponse = {
            status: () => 200,
            url: () => `${START_URL}/shared`,
        };
        // Two DIFFERENT request URLs resolve to the same final page.
        await handle(contextFor(`${START_URL}/a`, makePage(), redirectResponse));
        await handle(contextFor(`${START_URL}/b`, makePage(), redirectResponse));

        expect(siteDb.savePage).toHaveBeenCalledTimes(1);
        expect(siteDb.updatePageContent).toHaveBeenCalledTimes(1);
        expect(stats.pagesDiscovered).toBe(1);
    });

    it("counts a re-extracted duplicate link only when the insert lands", async () => {
        mockedExtractLinks.mockResolvedValue([
            { href: "/about", text: "About", dataTestId: null, tagName: "a", role: "link" },
            { href: "/about", text: "About", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const { deps, stats, siteDb } = makeDeps();
        // INSERT OR IGNORE: the duplicate reports 0 changes.
        siteDb.saveLink.mockReturnValueOnce(1).mockReturnValue(0);
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/`, makePage()));

        expect(siteDb.saveLink).toHaveBeenCalledTimes(2);
        expect(stats.linksFound).toBe(1);
    });
});

describe("save-time link verification", () => {
    it("verifies a new link on the spot when its target already committed this run", async () => {
        const { deps, siteDb } = makeDeps();
        const handle = createCrawlPageProcessor(deps);

        // /a commits first with no links; visitedUrls now contains it.
        mockedExtractLinks.mockResolvedValueOnce([] as never);
        await handle(contextFor(`${START_URL}/a`, makePage()));

        // /b then links back to /a (nav-style backlink) — commit-time
        // verification for /a already ran and cannot reach this link.
        mockedExtractLinks.mockResolvedValueOnce([
            { href: "/a", text: "A", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        await handle(contextFor(`${START_URL}/b`, makePage()));

        expect(siteDb.updateLinkStatus).toHaveBeenCalledWith(
            `${START_URL}/b`,
            `${START_URL}/a`,
            "verified",
        );
    });

    it("verifies a new link when its target exists from a previous run", async () => {
        mockedExtractLinks.mockResolvedValue([
            { href: "/old", text: "Old", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const { deps, siteDb } = makeDeps();
        siteDb.getPage
            .mockReturnValueOnce(null) // current page is fresh
            .mockReturnValue({ id: 9, url: `${START_URL}/old` } as never); // target: prior run
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/`, makePage()));

        expect(siteDb.updateLinkStatus).toHaveBeenCalledWith(
            `${START_URL}/`,
            `${START_URL}/old`,
            "verified",
        );
    });

    it("leaves a link pending when its target is neither visited nor stored", async () => {
        mockedExtractLinks.mockResolvedValue([
            { href: "/future", text: "Future", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const { deps, siteDb } = makeDeps();
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/`, makePage()));

        expect(siteDb.updateLinkStatus).not.toHaveBeenCalled();
    });
});

describe("public login page under a loaded session", () => {
    it("downgrades the auth blocker to log and keeps crawling", async () => {
        const blocker = authBlocker(`${START_URL}/login`, "auth:url_pattern");
        const { deps, siteDb, pause, emit, hasSeenAuthenticatedSuccess } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: STORAGE_STATE,
        });
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/login`, makePage("Sign in")));

        expect(pause).not.toHaveBeenCalled();
        expect(siteDb.saveBlocker).toHaveBeenCalledWith(
            expect.objectContaining({ severity: "log" }),
        );
        const emittedTypes = emit.mock.calls.map((c) => c[0].type);
        expect(emittedTypes).toContain("blocker_detected");
        expect(emittedTypes).not.toContain("auth_blocked");
        // The page itself is processed like any other page.
        expect(siteDb.savePage).toHaveBeenCalledTimes(1);
        expect(hasSeenAuthenticatedSuccess.current).toBe(true);
    });

    it("still pauses on a real wall: non-login URL bounced to /login", async () => {
        const blocker = authBlocker(`${START_URL}/dashboard`, "auth:login_redirect");
        const { deps, siteDb, pause, emit } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: STORAGE_STATE,
        });
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/dashboard`, makePage()));

        expect(pause).toHaveBeenCalledWith(
            expect.objectContaining({ blockedAtUrl: `${START_URL}/dashboard` }),
        );
        expect(siteDb.saveBlocker).toHaveBeenCalledWith(
            expect.objectContaining({ severity: "pause" }),
        );
        const emittedTypes = emit.mock.calls.map((c) => c[0].type);
        expect(emittedTypes).toContain("auth_blocked");
        expect(siteDb.savePage).not.toHaveBeenCalled();
    });

    it("still pauses when the server rejects the session (http_status on /login)", async () => {
        const blocker = authBlocker(`${START_URL}/login`, "auth:http_status");
        const { deps, pause } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: STORAGE_STATE,
        });
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/login`, makePage()));

        expect(pause).toHaveBeenCalled();
    });

    it("records /login without pausing when no session is loaded", async () => {
        const blocker = authBlocker(`${START_URL}/login`, "auth:url_pattern");
        const { deps, siteDb, pause, emit, requestQueue } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: null,
        });
        mockedExtractLinks.mockResolvedValue([
            { href: "/dashboard", text: "App", dataTestId: null, tagName: "a", role: "link" },
        ] as never);
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/login`, makePage("Sign in")));

        expect(pause).not.toHaveBeenCalled();
        expect(siteDb.savePage).toHaveBeenCalledWith(
            expect.objectContaining({
                url: `${START_URL}/login`,
                snapshotJson: expect.stringContaining("Sign in"),
            }),
        );
        const emittedTypes = emit.mock.calls.map((c) => c[0].type);
        expect(emittedTypes).not.toContain("auth_blocked");
        // Capture-then-stop: do not descend into protected routes without auth.
        expect(requestQueue.addRequests).not.toHaveBeenCalled();
    });
});

describe("login capture under --skip-auth", () => {
    it("saves a login page snapshot and does not crawl past auth", async () => {
        const blocker = authBlocker(`${START_URL}/login`, "auth:form");
        const { deps, siteDb, pause, emit, requestQueue } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: null,
        });
        deps.options.pauseOnAuth = false;
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/login`, makePage("Sign in")));

        expect(pause).not.toHaveBeenCalled();
        expect(siteDb.savePage).toHaveBeenCalledWith(
            expect.objectContaining({
                url: `${START_URL}/login`,
                snapshotJson: expect.stringContaining("Sign in"),
            }),
        );
        expect(emit.mock.calls.map((c) => c[0].type)).toContain("page_discovered");
        expect(requestQueue.addRequests).not.toHaveBeenCalled();
    });

    it("still skips non-login auth walls without saving a page", async () => {
        const blocker = authBlocker(`${START_URL}/dashboard`, "auth:login_redirect");
        const { deps, siteDb, pause, emit } = makeDeps({
            detectors: [authDetectorReturning(blocker)],
            playwrightStorageState: null,
        });
        deps.options.pauseOnAuth = false;
        const handle = createCrawlPageProcessor(deps);

        await handle(contextFor(`${START_URL}/dashboard`, makePage()));

        expect(pause).not.toHaveBeenCalled();
        expect(siteDb.savePage).not.toHaveBeenCalled();
        expect(emit.mock.calls.map((c) => c[0].type)).toContain("auth_blocked");
    });
});
