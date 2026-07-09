/**
 * Site Knowledge Loader Tests
 *
 * Covers formatSiteKnowledge's URL display rule: routes/paths must be
 * rendered as relative paths when a baseURL is known (matching the
 * generation prompt's "URLs MUST be relative" rule), and left absolute
 * otherwise or when they're cross-origin.
 */

import { describe, expect, it } from "vitest";

import { formatSiteKnowledge } from "../knowledge-loader";
import type { SiteKnowledge } from "../types";

function buildKnowledge(overrides: Partial<SiteKnowledge> = {}): SiteKnowledge {
    return {
        pagesDiscovered: 1,
        routes: [],
        verifiedPaths: [],
        authRequiredRoutes: [],
        workingSelectors: [],
        brokenLinks: [],
        ...overrides,
    };
}

describe("formatSiteKnowledge", () => {
    it("emits full URLs when no baseURL is known", () => {
        const knowledge = buildKnowledge({
            routes: [{ url: "http://localhost:3000/login", title: "Login", depth: 0 }],
        });
        const out = formatSiteKnowledge(knowledge);
        expect(out).toContain("http://localhost:3000/login");
    });

    it("strips the origin from same-origin routes when baseURL is set", () => {
        const knowledge = buildKnowledge({
            routes: [{ url: "http://localhost:3000/login", title: "Login", depth: 0 }],
        });
        const out = formatSiteKnowledge(knowledge, "http://localhost:3000");
        expect(out).toContain("- /login — Login");
        expect(out).not.toContain("http://localhost:3000/login");
    });

    it("leaves cross-origin routes (e.g. an OAuth provider) absolute", () => {
        const knowledge = buildKnowledge({
            routes: [{ url: "https://accounts.example.com/oauth", title: null, depth: 0 }],
        });
        const out = formatSiteKnowledge(knowledge, "http://localhost:3000");
        expect(out).toContain("https://accounts.example.com/oauth");
    });

    it("strips origin from verified navigation paths and auth-required routes", () => {
        const knowledge = buildKnowledge({
            verifiedPaths: [
                {
                    fromUrl: "http://localhost:3000/",
                    toUrl: "http://localhost:3000/dashboard",
                    selector: "a[href='/dashboard']",
                    linkText: "Dashboard",
                    verified: true,
                },
            ],
            authRequiredRoutes: ["http://localhost:3000/account"],
        });
        const out = formatSiteKnowledge(knowledge, "http://localhost:3000");
        expect(out).toContain("- / → /dashboard");
        expect(out).toContain("- /account");
        expect(out).not.toContain("http://localhost:3000/dashboard");
    });
});
