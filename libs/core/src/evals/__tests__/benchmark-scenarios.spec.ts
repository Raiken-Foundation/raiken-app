/**
 * Unit cover for the parts of the benchmark suite that don't need a fixture.
 *
 * The precondition table is the important one: it is the cheapest place the
 * "login prompts must not inherit a saved session" contract can break, and
 * running it here means `nx test core` catches it without a browser, minutes
 * before the integration gate would.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildBenchmarkScenarios,
    buildFixtureStorageState,
    evaluatePreconditionCases,
    PRECONDITION_CASES,
    PROTECTED_ROUTES,
} from "../scenarios/benchmark";
import { buildFlakinessScenario } from "../scenarios/flakiness";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const AUTH_DIR = path.join(REPO_ROOT, "tools", "playground-tasks");

describe("benchmark precondition cases", () => {
    it.each(PRECONDITION_CASES)("resolves $prompt to $expected", (testCase) => {
        const [result] = evaluatePreconditionCases([testCase]);
        expect(result.actual).toBe(testCase.expected);
    });

    it("only lets an authenticated case reuse storage state", () => {
        for (const result of evaluatePreconditionCases(PRECONDITION_CASES)) {
            expect(result.usesStorageState).toBe(result.expected === "authenticated");
        }
    });

    it("covers every precondition, so the table can't drift into one shape", () => {
        const covered = new Set(PRECONDITION_CASES.map((testCase) => testCase.expected));
        expect([...covered].sort()).toEqual(["authenticated", "login_flow", "unauthenticated"]);
    });
});

describe("fixture storage state", () => {
    it("carries a decodable admin session scoped to the target origin", () => {
        const state = JSON.parse(buildFixtureStorageState("http://127.0.0.1:5100"));
        const [cookie] = state.cookies;

        expect(cookie.name).toBe("raiken-session");
        expect(cookie.domain).toBe("127.0.0.1");
        const payload = JSON.parse(Buffer.from(cookie.value, "base64").toString("utf-8"));
        expect(payload.user).toBe("admin");
        expect(payload.permissions).toContain("manage:workspace");
        expect(payload.exp).toBeGreaterThan(Date.now());

        expect(state.origins[0].origin).toBe("http://127.0.0.1:5100");
        expect(state.origins[0].localStorage).toContainEqual({
            name: "playground-tasks-cookie-consent",
            value: "accepted",
        });
    });
});

describe("buildBenchmarkScenarios", () => {
    it("refuses to build against a directory that isn't the fixture", () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-benchmark-"));
        try {
            expect(() => buildBenchmarkScenarios({ tasksDir: empty })).toThrow(
                /tasks fixture not found/,
            );
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });

    it.skipIf(!fs.existsSync(path.join(AUTH_DIR, "node_modules", "vite", "bin", "vite.js")))(
        "produces uniquely identified scenarios that can all fail",
        () => {
            const scenarios = buildBenchmarkScenarios({ tasksDir: AUTH_DIR });
            const ids = scenarios.map((scenario) => scenario.id);

            expect(new Set(ids).size).toBe(ids.length);
            // A scenario with no scorers is reported as failed by the runner,
            // so an empty list here would be a permanently red gate.
            for (const scenario of scenarios) {
                expect(scenario.scorers.length).toBeGreaterThan(0);
            }
        },
    );

    it("names the protected routes discovery has to recall", () => {
        expect(PROTECTED_ROUTES).toContain("/settings");
        expect(PROTECTED_ROUTES.every((route) => route.startsWith("/"))).toBe(true);
    });
});

describe("flakiness suite-size gate", () => {
    const results = (count: number) =>
        Array.from({ length: count }, (_unused, index) => ({
            testFile: "tests/auth-flow.spec.ts",
            testName: `case ${index}`,
            status: "passed" as const,
            duration: 1,
        }));

    it("is only added when an expected count is given", () => {
        const withoutExpectation = buildFlakinessScenario({
            projectPath: "/tmp",
            testFile: "tests/auth-flow.spec.ts",
        });
        expect(withoutExpectation.scorers.map((s) => s.name)).not.toContain("runs-the-whole-suite");
    });

    it("fails a run that quietly collected fewer tests than the suite has", async () => {
        const scenario = buildFlakinessScenario({
            projectPath: "/tmp",
            testFile: "tests/auth-flow.spec.ts",
            expectedTests: 10,
        });
        const sizeScorer = scenario.scorers.find(
            (candidate) => candidate.name === "runs-the-whole-suite",
        );
        if (!sizeScorer) throw new Error("expected a suite-size scorer");

        const ctx = { workDir: "/tmp", baseUrl: null, log: () => {} };
        expect(await sizeScorer.score([results(10), results(10)], ctx)).toMatchObject({
            passed: true,
        });
        expect(await sizeScorer.score([results(10), results(2)], ctx)).toMatchObject({
            passed: false,
        });
    });
});
