import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphDB } from "../database/db";
import { SqliteDbAdapter } from "../database/adapter";
import { ContractStore } from "../contract/store";
import { computeCoverage, matchScore } from "../contract/coverage";
import { mintFromSiteKnowledge, mintObservedFact } from "../contract/mint";
import {
    parseRequirementsFile,
    importRequirements,
    parseTicketRequirements,
} from "../contract/intent";
import {
    buildContractView,
    contractToMarkdown,
    diffContracts,
} from "../contract/exporter";
import { diffObservable } from "../contract/capture";

describe("ContractStore", () => {
    let dir: string;
    let db: CodeGraphDB;
    let store: ContractStore;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-contract-")));
        db = new CodeGraphDB(dir);
        store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("upserts observed facts by stable key (no duplicates, counters bump)", () => {
        const first = store.upsertBehaviorFact({
            route: "/signup",
            precondition: null,
            action: "submit form empty",
            expectedObservable: 'shows "email required"',
            status: "verified",
            evidence: { source: "capture", capturedAt: 1 },
            sourceCommit: null,
            capturedAt: 1,
            lastVerifiedAt: null,
            verifiedCount: 0,
            violatedCount: 0,
        });
        expect(first.isNew).toBe(true);

        const second = store.upsertBehaviorFact({
            route: "/signup",
            precondition: null,
            action: "submit form empty",
            expectedObservable: 'shows "email required"',
            status: "verified",
            evidence: null,
            sourceCommit: null,
            capturedAt: 2,
            lastVerifiedAt: null,
            verifiedCount: 0,
            violatedCount: 0,
        });
        expect(second.isNew).toBe(false);
        expect(second.id).toBe(first.id);

        const facts = store.listBehaviorFacts();
        expect(facts).toHaveLength(1);
        expect(facts[0].verifiedCount).toBe(2);
    });

    it("distinguishes facts by precondition and observable", () => {
        const base = {
            route: "/notes",
            action: "click Add note",
            status: "verified" as const,
            evidence: null,
            sourceCommit: null,
            capturedAt: 1,
            lastVerifiedAt: null,
            verifiedCount: 0,
            violatedCount: 0,
        };
        store.upsertBehaviorFact({ ...base, precondition: null, expectedObservable: "adds note" });
        store.upsertBehaviorFact({ ...base, precondition: "signed in", expectedObservable: "adds note" });
        store.upsertBehaviorFact({ ...base, precondition: null, expectedObservable: "shows error" });
        expect(store.listBehaviorFacts()).toHaveLength(3);
    });

    it("upserts intent facts and records ticket traces", () => {
        const res = store.upsertIntentFact({
            requirementText: "checkout shows order number",
            routeHint: "/checkout",
            ticketId: "42",
            ticketProvider: "github",
            ticketSeverity: null,
            ticketUrl: null,
            neverRegress: false,
            status: "uncovered",
            matchedFactId: null,
            source: "ticket",
            importedAt: 1,
        });
        expect(res.isNew).toBe(true);
        store.addTrace(res.id, "intent", "ticket", "42");
        expect(store.listTraces("intent")).toHaveLength(1);
        // Re-import same text under same source+ticket → upsert, not duplicate.
        const again = store.upsertIntentFact({
            requirementText: "checkout shows order number",
            routeHint: null,
            ticketId: "42",
            ticketProvider: "github",
            ticketSeverity: null,
            ticketUrl: null,
            neverRegress: false,
            status: "uncovered",
            matchedFactId: null,
            source: "ticket",
            importedAt: 2,
        });
        expect(again.isNew).toBe(false);
        expect(store.listIntentFacts()).toHaveLength(1);
    });
});

describe("coverage matching", () => {
    it("scores route agreement and token overlap", () => {
        const score = matchScore(
            { requirementText: "newsletter form shows an error for empty email", routeHint: "/" },
            {
                route: "http://x/",
                action: 'submit "Subscribe" form empty',
                expectedObservable: 'shows "Please enter an email address."',
            },
        );
        expect(score).toBeGreaterThan(0.34);
    });

    it("marks requirements with no matching fact uncovered", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cov-")));
        const db = new CodeGraphDB(dir);
        const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
        try {
            store.upsertBehaviorFact({
                route: "/signup",
                precondition: null,
                action: "submit form empty",
                expectedObservable: 'shows "email required"',
                status: "verified",
                evidence: null,
                sourceCommit: null,
                capturedAt: 1,
                lastVerifiedAt: null,
                verifiedCount: 0,
                violatedCount: 0,
            });
            store.upsertIntentFact({
                requirementText: "FREESHIP promo code gives free shipping",
                routeHint: "/checkout",
                ticketId: null,
                ticketProvider: null,
                ticketSeverity: null,
                ticketUrl: null,
                neverRegress: false,
                status: "uncovered",
                matchedFactId: null,
                source: "file",
                importedAt: 1,
            });
            const report = computeCoverage(store);
            expect(report.total).toBe(1);
            expect(report.uncovered).toBe(1);
            expect(report.entries[0].verdict).toBe("uncovered");
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("minting", () => {
    it("mints facts from discovered pages (headings + forms)", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-mint-")));
        const db = new CodeGraphDB(dir);
        try {
            const raw = db.getRawDatabase();
            raw
                .prepare(
                    `INSERT INTO discovered_pages
                     (project_path, url, normalized_url, title, snapshot_json, forms_json, parent_url,
                      navigation_action, depth, discovered_at, last_visited_at, visit_count, captured_authenticated)
                     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, 1, 1, 0)`,
                )
                .run(
                    dir,
                    "http://x/signup",
                    "http://x/signup",
                    "Signup",
                    '- banner:\n  - heading "Create account" [level=1]',
                    JSON.stringify({
                        fields: [{ label: "Email", type: "email" }],
                        submits: ["Subscribe"],
                    }),
                );
            const result = mintFromSiteKnowledge(raw, dir);
            expect(result.minted).toBe(2);
            const store = new ContractStore(new SqliteDbAdapter(raw, dir));
            const facts = store.listBehaviorFacts();
            expect(facts.some((f) => f.expectedObservable.includes("Create account"))).toBe(true);
            expect(facts.some((f) => f.expectedObservable.includes("Email"))).toBe(true);
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("mints a captured state change via mintObservedFact", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-mint2-")));
        const db = new CodeGraphDB(dir);
        try {
            const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
            const res = mintObservedFact(store, {
                route: "/signup",
                precondition: null,
                action: "submit form empty",
                expectedObservable: 'shows "email required"',
                evidence: { source: "capture", capturedAt: 1, beforeText: "a", afterText: "a\nemail required" },
            });
            expect(res.isNew).toBe(true);
            expect(store.getBehaviorFactByKey(res.factKey)?.expectedObservable).toContain("email required");
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("intent parsing", () => {
    it("parses checkbox, AC-numbered, and plain bullet requirements", () => {
        const parsed = parseRequirementsFile(`
# Title
- [ ] AC-1: newsletter shows an error for empty email
- the catalog filters by author
2. checkout computes totals
ignored short
`);
        expect(parsed).toHaveLength(3);
        expect(parsed[0].text).toContain("newsletter");
    });

    it("flags never-regress requirements", () => {
        const parsed = parseRequirementsFile(
            "- [ ] the login crash must not regress after the fix",
        );
        expect(parsed[0].neverRegress).toBe(true);
    });

    it("extracts criteria sentences from free-form ticket bodies", () => {
        const parsed = parseTicketRequirements(
            "Fix checkout",
            "Random intro line.\nThe checkout page must show the order number.\nSome notes.",
        );
        expect(parsed.length).toBe(1);
        expect(parsed[0].text).toContain("order number");
    });

    it("skips near-duplicate requirements on import", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-intent-")));
        const db = new CodeGraphDB(dir);
        try {
            const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
            importRequirements(store, "file", [{ text: "checkout shows totals", routeHint: null, neverRegress: false }]);
            const again = importRequirements(store, "file", [
                { text: "checkout  shows totals", routeHint: null, neverRegress: false },
            ]);
            expect(again.imported).toBe(0);
            expect(again.skipped).toBe(1);
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("export + diff", () => {
    it("renders markdown and diffs views by stable keys", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-export-")));
        const db = new CodeGraphDB(dir);
        try {
            const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
            const before = buildContractView(store, dir);
            const md = contractToMarkdown(before);
            expect(md).toContain("# Behavior Contract");

            store.upsertBehaviorFact({
                route: "/x",
                precondition: null,
                action: "click save",
                expectedObservable: "shows saved",
                status: "verified",
                evidence: null,
                sourceCommit: null,
                capturedAt: 1,
                lastVerifiedAt: null,
                verifiedCount: 0,
                violatedCount: 0,
            });
            const after = buildContractView(store, dir);
            const diff = diffContracts(before, after);
            expect(diff.addedFacts).toHaveLength(1);
            expect(diff.addedFacts[0]).toContain("shows saved");
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("fact confidence", () => {
    it("derives confidence from verification history", async () => {
        const { confidenceFromHistory } = await import("../contract/store");
        expect(confidenceFromHistory(0, 0)).toBe(0.5);
        expect(confidenceFromHistory(20, 0)).toBe(1);
        expect(confidenceFromHistory(1, 1)).toBe(0);
        expect(confidenceFromHistory(2, 3)).toBe(0); // floored at 0
        expect(confidenceFromHistory(5, 1)).toBeCloseTo(0.667, 2);
    });

    it("fact rows carry the derived confidence", () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raiken-conf-")));
        const db = new CodeGraphDB(dir);
        try {
            const store = new ContractStore(new SqliteDbAdapter(db.getRawDatabase(), dir));
            store.upsertBehaviorFact({
                route: "/a",
                precondition: null,
                action: "open /a",
                expectedObservable: "shows x",
                status: "verified",
                evidence: null,
                sourceCommit: null,
                capturedAt: 1,
                lastVerifiedAt: null,
                verifiedCount: 0,
                violatedCount: 0,
            });
            const fact = store.listBehaviorFacts()[0];
            expect(fact.confidence).toBe(1);
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("diffObservable", () => {
    it("returns the first added meaningful line", () => {
        expect(diffObservable("Title\n\nBody", "Title\n\nBody\nPlease enter an email address.")).toBe(
            "Please enter an email address.",
        );
        expect(diffObservable("same", "same")).toBeNull();
    });
});
