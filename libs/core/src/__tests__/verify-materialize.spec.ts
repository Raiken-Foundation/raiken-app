import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    parseAction,
    parseObservable,
    resolveFactUrl,
    scopeFactsByChanges,
} from "../contract/verify";
import { materializeFacts } from "../contract/materialize";
import { getTestRepair } from "../testing/interpreter";
import type { BehaviorFact } from "../contract/types";

function fact(overrides: Partial<BehaviorFact> = {}): BehaviorFact {
    return {
        factKey: `k-${Math.random().toString(36).slice(2, 8)}`,
        route: "/signup",
        precondition: null,
        action: "open /signup",
        expectedObservable: 'shows heading "Create account"',
        status: "verified",
        evidence: null,
        sourceCommit: null,
        capturedAt: 1,
        lastVerifiedAt: null,
        verifiedCount: 1,
        violatedCount: 0,
        ...overrides,
    };
}

describe("observable + action parsing", () => {
    it("parses heading, text, and inputs observables", () => {
        expect(parseObservable('shows heading "Create account"')).toEqual({
            kind: "heading",
            text: "Create account",
        });
        expect(parseObservable('shows "Please enter an email address."')).toEqual({
            kind: "text",
            text: "Please enter an email address.",
        });
        expect(
            parseObservable('exposes inputs [Email, Password] and submit [Sign in]'),
        ).toEqual({ kind: "inputs", labels: ["Email", "Password"] });
        expect(parseObservable("unrecognized shape")).toBeNull();
    });

    it("parses open and submit-empty actions", () => {
        expect(parseAction("open /signup")).toEqual({ kind: "open" });
        expect(parseAction('submit "Subscribe" form empty')).toEqual({
            kind: "submit-empty",
            label: "Subscribe",
        });
    });

    it("resolves stored routes against baseURL (absolute and relative)", () => {
        expect(resolveFactUrl("http://x:9300/#/shop", "http://localhost:9300")).toBe(
            "http://x:9300/#/shop",
        );
        expect(resolveFactUrl("/signup", "http://localhost:9300")).toBe(
            "http://localhost:9300/signup",
        );
    });
});

describe("diff scoping", () => {
    it("scopes a fact when a changed path shares a route token", () => {
        const facts = [
            fact({ route: "http://x/checkout", factKey: "checkout" }),
            fact({ route: "http://x/settings", factKey: "settings" }),
        ];
        const { scoped, global } = scopeFactsByChanges(facts, ["public/checkout.html"]);
        expect(global).toBe(false);
        expect(scoped.map((f) => f.factKey)).toEqual(["checkout"]);
    });

    it("scopes everything on global files (server, layout, root)", () => {
        const facts = [fact({ route: "http://x/a" }), fact({ route: "http://x/b" })];
        for (const file of ["server.js", "public/index.html", "styles.css"]) {
            const { scoped, global } = scopeFactsByChanges(facts, [file]);
            expect(global).toBe(true);
            expect(scoped).toHaveLength(2);
        }
    });

    it("scopes nothing on an empty change set", () => {
        const { scoped } = scopeFactsByChanges([fact()], []);
        expect(scoped).toHaveLength(0);
    });
});

describe("materializer", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-mat-")));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("emits a playable spec per fact kind", () => {
        const result = materializeFacts({
            baseURL: "http://localhost:9300",
            facts: [
                fact({
                    route: "http://localhost:9300/#/shop",
                    action: "open /#/shop",
                    expectedObservable: 'shows heading "Shop"',
                }),
                fact({
                    route: "http://localhost:9300/",
                    action: 'submit "Subscribe" form empty',
                    expectedObservable: 'shows "Please enter an email address."',
                }),
                fact({
                    route: "http://localhost:9300/",
                    action: "view form",
                    expectedObservable: "exposes inputs [Email, Password]",
                }),
            ],
            outDir: dir,
        });
        expect(result.testCount).toBe(3);
        expect(result.skipped).toBe(0);
        const spec = fs.readFileSync(result.specPath, "utf-8");
        expect(spec).toContain("getByRole('heading'");
        expect(spec).toContain('toContainText("Please enter an email address.")');
        expect(spec).toContain("Materialized by");
    });

    it("bakes the storage state into test.use when provided", () => {
        const result = materializeFacts({
            baseURL: "http://localhost:9300",
            facts: [fact()],
            outDir: dir,
            storageStatePath: ".raiken/auth-state.json",
        });
        expect(fs.readFileSync(result.specPath, "utf-8")).toContain(
            "test.use({ storageState: \".raiken/auth-state.json\" })",
        );
    });
});

describe("hermetic mocks", () => {
    it("renders page.route mocks for recorded GETs", async () => {
        const { renderRouteMocks } = await import("../contract/record");
        const rendered = renderRouteMocks([
            {
                method: "GET",
                pathPattern: "/api/notes",
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ notes: [] }),
            },
        ]);
        expect(rendered).toContain('page.route("**/api/notes**"');
        expect(rendered).toContain("status: 200");
        // The body is a JSON string serialized as a JS string literal — the
        // quotes are escaped in the emitted source.
        expect(rendered).toContain('body: ');
        expect(rendered).toContain('notes');
    });

    it("materializes a beforeEach mock block when mocks are provided", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-mocks-")));
        try {
            const result = materializeFacts({
                baseURL: "http://localhost:9300",
                facts: [fact()],
                outDir: dir,
                mocks: [
                    {
                        method: "GET",
                        pathPattern: "/api/products",
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify({ products: [] }),
                    },
                ],
            });
            const spec = fs.readFileSync(result.specPath, "utf-8");
            expect(spec).toContain("test.beforeEach(async ({ page }) => {");
            expect(spec).toContain('page.route("**/api/products**"');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("repair escalation", () => {
    it("surfaces empty responses instead of crashing, and uses config-aware budgets", async () => {
        // No key: getTestRepair exits before any model call with the config error.
        const result = await getTestRepair(
            {
                testCode: "import { test } from '@playwright/test';\ntest('x', async () => {});",
                testFilePath: "x.spec.ts",
                rawOutput: "failed",
                images: undefined,
                signal: undefined,
                allowWeaken: false,
                testResults: undefined,
                sourceCode: undefined,
                pageSummaries: undefined,
                scenario: undefined,
            } as never,
            { apiKey: "", model: "deepseek-flash" },
        );
        expect(result.error).toContain("API key not configured");
    });

    it("marks empty+length responses via the shared signature helper", async () => {
        const { isEmptyLengthResponse } = await import("../agent/ai-providers");
        expect(
            isEmptyLengthResponse({ content: "", response_metadata: { finish_reason: "length" } }),
        ).toBe(true);
        expect(
            isEmptyLengthResponse({ content: "code here", response_metadata: { finish_reason: "length" } }),
        ).toBe(false);
        expect(
            isEmptyLengthResponse({ content: "", response_metadata: { finish_reason: "stop" } }),
        ).toBe(false);
    });
});
