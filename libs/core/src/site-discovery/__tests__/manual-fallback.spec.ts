/**
 * Manual fallback detector tests.
 *
 * Drives `createManualFallbackDetector().detect()` through stub `Page` /
 * `Response` objects, mirroring the style of `auth-detector.spec.ts`. Each
 * category (`rate_limited`, `consent_wall`, `geo_blocked`, `interstitial`,
 * plus the pre-existing `error_page`/`captcha`) gets a positive and at
 * least one negative case so a detector can't be "always true".
 */

import { describe, expect, it } from "vitest";

import { createManualFallbackDetector } from "../detectors/manual-fallback";

const PROJECT_PATH = "/test/project";
const detector = createManualFallbackDetector();

interface FakeLocator {
    count: () => Promise<number>;
    first: () => FakeLocator;
    nth: (i: number) => FakeLocator;
    isVisible: () => Promise<boolean>;
    boundingBox: () => Promise<{ width: number; height: number; x: number; y: number } | null>;
    textContent: () => Promise<string | null>;
    locator: (selector: string) => FakeLocator;
}

function defaultLocator(): FakeLocator {
    const self: FakeLocator = {
        count: async () => 0,
        first: () => self,
        nth: () => self,
        isVisible: async () => false,
        boundingBox: async () => null,
        textContent: async () => null,
        locator: () => defaultLocator(),
    };
    return self;
}

function visibleLocator(overrides: Partial<FakeLocator> = {}): FakeLocator {
    const self: FakeLocator = {
        count: async () => 1,
        first: () => self,
        nth: () => self,
        isVisible: async () => true,
        boundingBox: async () => ({ width: 300, height: 65, x: 0, y: 0 }),
        textContent: async () => null,
        locator: () => defaultLocator(),
        ...overrides,
    };
    return self;
}

function makePage(opts: {
    content?: string;
    locators?: Record<string, FakeLocator>;
    overlay?: {
        selector: string;
        coveragePct: number;
        reachableOutside: number;
        looksLikeAppShell: boolean;
    } | null;
    consentBlocking?: boolean;
}) {
    const locators = opts.locators ?? {};
    return {
        content: async () => opts.content ?? "<html><body></body></html>",
        locator(selector: string) {
            return locators[selector] ?? defaultLocator();
        },
        // getVisibleText tries evaluate() first and falls back to content()
        // on any failure — this fake distinguishes the interstitial-overlay
        // evaluate call (by its distinctive `innerWidth` reference) from
        // the visible-text evaluate call and rejects the latter so tests
        // stay content()-driven, matching auth-detector.spec.ts.
        async evaluate(fn: (...args: unknown[]) => unknown) {
            if (fn.toString().includes("consentCandidates")) {
                return opts.consentBlocking ?? false;
            }
            if (fn.toString().includes("innerWidth")) {
                return opts.overlay ?? null;
            }
            throw new Error("evaluate not supported in test double");
        },
    } as unknown as import("playwright").Page;
}

function makeResponse(
    status: number,
    opts: { statusText?: string; headers?: Record<string, string> } = {},
) {
    return {
        status: () => status,
        statusText: () => opts.statusText ?? "",
        headers: () => opts.headers ?? {},
        url: () => "http://localhost:3000/",
        request: () => null,
    } as unknown as import("playwright").Response;
}

describe("manual fallback detector — error_page / captcha (existing coverage)", () => {
    it("flags a 503 as error_page", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({}),
            response: makeResponse(503),
        });
        expect(blocker?.category).toBe("error_page");
    });

    it("still flags vendor 5xx like Cloudflare's 520", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({}),
            response: makeResponse(520),
        });
        expect(blocker?.category).toBe("error_page");
    });

    it("ignores synthetic proxy statuses (590–599) — no origin answered", async () => {
        // 594 "Connection Refused" is proxy-chain's fabricated response when
        // the upstream connect fails; it paused crawls against healthy apps.
        for (const status of [590, 594, 599]) {
            const blocker = await detector.detect({
                projectPath: PROJECT_PATH,
                url: "http://localhost:3000/",
                page: makePage({}),
                response: makeResponse(status, { statusText: "Connection Refused" }),
            });
            expect(blocker?.category).not.toBe("error_page");
        }
    });

    it("flags a Cloudflare Turnstile iframe as captcha", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                locators: {
                    'iframe[src*="challenges.cloudflare.com"]': visibleLocator(),
                },
            }),
        });
        expect(blocker?.category).toBe("captcha");
    });
});

describe("manual fallback detector — rate_limited", () => {
    it("flags a 429 response", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/search",
            page: makePage({}),
            response: makeResponse(429, {
                statusText: "Too Many Requests",
                headers: { "retry-after": "30" },
            }),
        });
        expect(blocker?.category).toBe("rate_limited");
        expect(blocker?.detectorId).toBe("manual:rate_limited");
        const evidence = JSON.parse(blocker?.evidenceJson ?? "{}");
        expect(evidence.status).toBe(429);
        expect(evidence.retryAfter).toBe("30");
    });

    it("does not flag a 429-less error status as rate_limited", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/search",
            page: makePage({}),
            response: makeResponse(404),
        });
        expect(blocker?.category).not.toBe("rate_limited");
    });

    it("takes priority over the 5xx error_page bucket", async () => {
        // 429 is < 500 so checkServerError would ignore it anyway, but this
        // asserts the ordering explicitly in case that threshold ever moves.
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/search",
            page: makePage({}),
            response: makeResponse(429),
        });
        expect(blocker?.category).toBe("rate_limited");
    });
});

describe("manual fallback detector — consent_wall", () => {
    it("flags a visible OneTrust banner", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                consentBlocking: true,
                locators: {
                    "#onetrust-banner-sdk": visibleLocator(),
                },
            }),
        });
        expect(blocker?.category).toBe("consent_wall");
        expect(blocker?.detectorId).toBe("manual:consent_wall");
        const evidence = JSON.parse(blocker?.evidenceJson ?? "{}");
        expect(evidence.provider).toBe("OneTrust");
    });

    it("ignores a hidden (already-dismissed) OneTrust banner", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                locators: {
                    "#onetrust-banner-sdk": visibleLocator({ isVisible: async () => false }),
                },
            }),
        });
        expect(blocker?.category).not.toBe("consent_wall");
    });

    it("flags a generic role=dialog cookie banner with an accept button", async () => {
        const dialog = visibleLocator({
            textContent: async () => "We use cookies to improve your experience. Accept all?",
            locator: () => visibleLocator(), // accept button present
        });
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                consentBlocking: true,
                locators: { '[role="dialog"]': dialog },
            }),
        });
        expect(blocker?.category).toBe("consent_wall");
        expect(blocker?.detectorId).toBe("manual:consent_wall_generic");
    });

    it("does NOT flag a non-blocking consent banner over reachable page content", async () => {
        const dialog = visibleLocator({
            textContent: async () => "We use cookies to improve your experience. Accept all?",
            locator: () => visibleLocator(),
        });
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/auth/login",
            page: makePage({
                consentBlocking: false,
                locators: { '[role="dialog"]': dialog },
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag a generic role=dialog with consent copy but no accept button", async () => {
        const dialog = visibleLocator({
            textContent: async () => "This site uses cookies.",
            locator: () => defaultLocator(), // no accept button
        });
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                locators: { '[role="dialog"]': dialog },
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag an unrelated role=dialog (e.g. a delete-confirmation modal)", async () => {
        const dialog = visibleLocator({
            textContent: async () => "Are you sure you want to delete this project?",
            locator: () => visibleLocator(),
        });
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                locators: { '[role="dialog"]': dialog },
            }),
        });
        expect(blocker).toBeNull();
    });
});

describe("manual fallback detector — geo_blocked", () => {
    it("flags 'not available in your region' copy", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/watch/123",
            page: makePage({
                content:
                    "<html><body><h1>This content is not available in your region.</h1></body></html>",
            }),
        });
        expect(blocker?.category).toBe("geo_blocked");
        expect(blocker?.detectorId).toBe("manual:geo_blocked");
    });

    it("flags generic 'geo-blocked' copy", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                content: "<html><body><p>Sorry, this stream is geo-blocked.</p></body></html>",
            }),
        });
        expect(blocker?.category).toBe("geo_blocked");
    });

    it("does NOT flag an unrelated 404 page", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/missing",
            page: makePage({
                content: "<html><body><h1>Page not found</h1></body></html>",
            }),
        });
        expect(blocker).toBeNull();
    });
});

describe("manual fallback detector — interstitial", () => {
    it("flags a viewport-covering overlay with no reachable content behind it", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                // A real interstitial (age gate, splash) contains a button or
                // two of its own — that must not read as "reachable content".
                overlay: {
                    selector: "div.full-page-overlay",
                    coveragePct: 0.95,
                    reachableOutside: 0,
                    looksLikeAppShell: false,
                },
            }),
        });
        expect(blocker?.category).toBe("interstitial");
        expect(blocker?.detectorId).toBe("manual:interstitial");
        const evidence = JSON.parse(blocker?.evidenceJson ?? "{}");
        expect(evidence.selector).toBe("div.full-page-overlay");
    });

    it("does NOT flag an overlay when normal interactive content is still reachable", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                overlay: {
                    selector: "div.promo-banner",
                    coveragePct: 0.9,
                    reachableOutside: 3,
                    looksLikeAppShell: false,
                },
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag a full-viewport SPA app-shell wrapper", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({
                // `#root { position: absolute; inset: 0 }` — everything lives
                // inside it, but it's rich with nav/links, not a blocker.
                overlay: {
                    selector: "div#root",
                    coveragePct: 1,
                    reachableOutside: 0,
                    looksLikeAppShell: true,
                },
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag a page with no overlay at all", async () => {
        const blocker = await detector.detect({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/",
            page: makePage({ overlay: null }),
        });
        expect(blocker).toBeNull();
    });
});
