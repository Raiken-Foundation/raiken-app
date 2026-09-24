/**
 * Test interpreter prompt builder.
 *
 * This is an "eval-style" regression test for the AI insights feature.
 * The interpreter calls a paid model (OpenRouter / Claude Sonnet 4.5),
 * so we can't cheaply assert on its actual output in unit tests. What
 * we CAN assert is: the prompt we send actually contains every piece of
 * evidence the dashboard claims to be forwarding.
 *
 * The original bug (audit issue: "AI insights diverge from artifacts")
 * was a context-gap — we were dropping `rawOutput`, attachments, and
 * sometimes the wrong test code. Each case below pins down one of those
 * fields and would have caught the regression at PR time.
 *
 * If a prompt section gets renamed (e.g. "# Failures" → "## Failures"),
 * update the assertions deliberately — those headings are part of the
 * model's contract.
 */

import { describe, expect, it } from "vitest";
import {
    buildInterpretationPrompt,
    buildRepairPrompt,
    type InterpretationContext,
    type RepairContext,
} from "../testing/interpreter";

const baseContext = (overrides: Partial<InterpretationContext> = {}): InterpretationContext => ({
    testResults: [],
    testCode: "import { test } from '@playwright/test';\ntest('noop', () => {});",
    projectPath: "/tmp/proj",
    ...overrides,
});

describe("buildInterpretationPrompt", () => {
    describe("evidence-grounding instructions", () => {
        it("instructs the model to ground claims in evidence", () => {
            const prompt = buildInterpretationPrompt(baseContext());
            // The "ground every claim" instruction is the core guardrail
            // against the divergence bug. If this string disappears,
            // we've regressed to the pre-fix prompt.
            expect(prompt).toMatch(/ground every claim/i);
            expect(prompt).toMatch(/do not invent/i);
        });

        it("instructs the model to flag context-mismatch when the test code doesn't contain the failing locator", () => {
            const prompt = buildInterpretationPrompt(baseContext());
            // This is the explicit handoff for the "wrong file sent"
            // case. Without it the model just invents a plausible-but-
            // wrong root cause.
            expect(prompt).toMatch(/context-mismatch/i);
        });
    });

    describe("test code", () => {
        it("includes the test code under a 'Test code' heading", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({ testCode: "// MARKER_TEST_CODE\ntest('a', () => {});" }),
            );
            expect(prompt).toContain("# Test code");
            expect(prompt).toContain("MARKER_TEST_CODE");
        });

        it("anchors the test code to a path when testFilePath is provided", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({ testFilePath: "tests/auth.spec.ts" }),
            );
            // The path is the model's signal for context-mismatch
            // detection — if the path is missing, the model has no
            // ground truth for "which file's locators should I expect".
            expect(prompt).toContain("tests/auth.spec.ts");
        });

        it("truncates pathologically large test code", () => {
            const huge = "x".repeat(20_000);
            const prompt = buildInterpretationPrompt(baseContext({ testCode: huge }));
            // We don't pin the exact budget — that's a tuning knob —
            // but we DO pin that truncation happens at all, otherwise
            // a single bloated file could blow the context window.
            expect(prompt.length).toBeLessThan(huge.length);
            expect(prompt).toMatch(/truncated/i);
        });
    });

    describe("failures section", () => {
        it("includes failed-test error message and snippet", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "should log in",
                            suite: "Auth",
                            status: "failed",
                            error: {
                                message: "locator.click: Timeout 5000ms exceeded.",
                                snippet: "await page.getByRole('button', { name: /log in/i })",
                                location: { file: "/abs/auth.spec.ts", line: 16, column: 5 },
                            },
                        },
                    ],
                }),
            );
            expect(prompt).toContain("# Failures");
            expect(prompt).toContain("Auth > should log in");
            expect(prompt).toContain("locator.click: Timeout 5000ms exceeded");
            expect(prompt).toContain("getByRole('button', { name: /log in/i })");
            // Path basename only — no leak of the full absolute path.
            expect(prompt).toContain("auth.spec.ts:16:5");
        });

        it("strips ANSI colour codes from error messages", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "test",
                            suite: "S",
                            status: "failed",
                            error: { message: "\u001b[31mRed error\u001b[0m on line" },
                        },
                    ],
                }),
            );
            // ANSI control chars waste tokens and confuse the model.
            expect(prompt).not.toContain("\u001b[31m");
            expect(prompt).toContain("Red error on line");
        });

        it("omits the failures section entirely when nothing failed", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [{ name: "ok", suite: "S", status: "passed" }],
                }),
            );
            expect(prompt).not.toContain("# Failures");
            // All-pass runs should still get a positive signal back.
            expect(prompt).toMatch(/working well/i);
        });
    });

    describe("attachments (regression: AI insights ignored on-disk artifacts)", () => {
        it("lists each attachment under its failed test", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "should log in",
                            suite: "Auth",
                            status: "failed",
                            attachments: [
                                {
                                    name: "test-failed-1.png",
                                    contentType: "image/png",
                                    path: "/results/test-failed-1.png",
                                },
                                {
                                    name: "video.webm",
                                    contentType: "video/webm",
                                    path: "/results/video.webm",
                                },
                                {
                                    name: "trace.zip",
                                    contentType: "application/zip",
                                    path: "/results/trace.zip",
                                },
                            ],
                        },
                    ],
                }),
            );
            expect(prompt).toMatch(/Attachments captured at failure time/i);
            expect(prompt).toContain("test-failed-1.png");
            expect(prompt).toContain("video.webm");
            expect(prompt).toContain("trace.zip");
        });

        it("annotates failure screenshots with their semantic role", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "x",
                            suite: "S",
                            status: "failed",
                            attachments: [
                                {
                                    name: "test-failed-1.png",
                                    contentType: "image/png",
                                },
                            ],
                        },
                    ],
                }),
            );
            // The role hint is the difference between "the model
            // mentions a screenshot exists" and "the model knows the
            // screenshot is captured at the moment of failure and
            // therefore proves what the page looked like when the
            // assertion blew up".
            expect(prompt).toMatch(/captured at the moment.*failure/i);
        });

        it("renders trace.zip as 'Playwright trace' with the show-trace command", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "x",
                            suite: "S",
                            status: "failed",
                            attachments: [
                                {
                                    name: "trace.zip",
                                    contentType: "application/zip",
                                },
                            ],
                        },
                    ],
                }),
            );
            expect(prompt).toMatch(/Playwright trace/);
            expect(prompt).toMatch(/show-trace/);
        });
    });

    describe("rawOutput (regression: AI insights had no Call log)", () => {
        it("includes the raw output under a clearly labelled section", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    rawOutput:
                        "Running 1 test\n\nlocator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: /log in/i })\n",
                }),
            );
            expect(prompt).toContain("# Raw run output");
            // The "Call log:" line is the single most actionable
            // string — it tells the model exactly which selector
            // Playwright was waiting on. If this disappears, the
            // model is back to guessing.
            expect(prompt).toContain("Call log:");
            expect(prompt).toContain("waiting for getByRole('button', { name: /log in/i })");
        });

        it("tail-truncates very long raw output (keeps the actionable end)", () => {
            // Massive head, short tail with the smoking gun. After
            // truncation the smoking gun must survive.
            const padding = "noise\n".repeat(5000);
            const tail = "FINAL_LINE_WITH_REAL_ERROR";
            const prompt = buildInterpretationPrompt(
                baseContext({ rawOutput: `${padding}${tail}` }),
            );
            expect(prompt).toContain(tail);
            expect(prompt).toMatch(/truncated/i);
        });

        it("omits the section when rawOutput is empty/whitespace only", () => {
            const prompt = buildInterpretationPrompt(baseContext({ rawOutput: "   \n  " }));
            expect(prompt).not.toContain("# Raw run output");
        });
    });

    describe("optional sections", () => {
        it("includes source-under-test when supplied", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({ sourceCode: "// SOURCE_MARKER\nexport function x() {}" }),
            );
            expect(prompt).toContain("# Source under test");
            expect(prompt).toContain("SOURCE_MARKER");
        });

        it("includes DOM context when supplied", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    domContext: {
                        url: "http://localhost:5100/login",
                        title: "Login",
                        accessibilityTree: null,
                        timestamp: 0,
                        interactiveElements: [
                            {
                                tagName: "button",
                                role: "button",
                                name: "Sign in",
                                text: "Sign in",
                                suggestedSelectors: ["[data-testid='login-submit']"],
                            },
                        ],
                        formFields: [
                            {
                                name: "username",
                                type: "text",
                                required: true,
                                suggestedSelector: "#username",
                            },
                        ],
                    },
                }),
            );
            expect(prompt).toContain("# DOM context");
            expect(prompt).toContain("http://localhost:5100/login");
            // The actual button text "Sign in" being in the DOM
            // section is what would let the model spot a
            // /log in/i regex mismatch — exactly the user-visible
            // bug from the discovery audit.
            expect(prompt).toContain("Sign in");
            expect(prompt).toContain("[data-testid='login-submit']");
        });
    });

    describe("output schema instructions", () => {
        it("requests a Summary and a Failures section when there are failures", () => {
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        {
                            name: "x",
                            suite: "S",
                            status: "failed",
                            error: { message: "boom" },
                        },
                    ],
                }),
            );
            expect(prompt).toMatch(/\*\*1\. Summary\*\*/);
            expect(prompt).toMatch(/\*\*2\. Failures\*\*/);
        });

        it("makes the test-quality section explicitly optional when there are failures", () => {
            // Regression: the previous prompt unconditionally asked for a
            // "Quality" section, which biased the model toward "fix the
            // test" even when the failure was an app regression. Quality
            // critique should be opt-in based on visible weakness in the
            // supplied test code.
            const prompt = buildInterpretationPrompt(
                baseContext({
                    testResults: [
                        { name: "x", suite: "S", status: "failed", error: { message: "boom" } },
                    ],
                }),
            );
            expect(prompt).toMatch(/test quality observations/i);
            expect(prompt).toMatch(/optional/i);
        });

        it("requests a 'What's working well' section only when there are no failures", () => {
            const passing = buildInterpretationPrompt(
                baseContext({
                    testResults: [{ name: "x", suite: "S", status: "passed" }],
                }),
            );
            expect(passing).toMatch(/what's working well/i);
            expect(passing).not.toMatch(/test quality observations/i);
        });
    });

    describe("balanced fault attribution (regression: prompt biased toward 'fix the test')", () => {
        // The original prompt categorised failures as "selector mismatch,
        // timing/race, logic bug, environment, or context-mismatch" — every
        // one of those except the ambiguous "logic bug" frames the test as
        // the suspect. Real failures are just as likely to be application
        // regressions, missing data, or an environment problem. The model
        // needs to consider all sides before recommending a fix.
        const failingContext = () =>
            baseContext({
                testResults: [
                    {
                        name: "should log in",
                        suite: "Auth",
                        status: "failed",
                        error: { message: "locator.click: Timeout 5000ms exceeded." },
                    },
                ],
            });

        it("instructs the model not to assume either side is wrong by default", () => {
            // Truly balanced framing: not "don't assume the test is wrong"
            // (still test-centric), but "don't assume either side is wrong"
            // (neutral). The model should weigh test, application, and
            // environment as equally plausible until the evidence narrows it.
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/do not assume either side is wrong/i);
        });

        it("offers Application as a first-class fault attribution", () => {
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/\*\*Application\*\*/);
            expect(prompt).toMatch(/regression/i);
        });

        it("offers Test as a first-class fault attribution", () => {
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/\*\*Test\*\*/);
        });

        it("offers Environment / data as a first-class fault attribution", () => {
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/\*\*Environment ?\/ ?data\*\*/i);
        });

        it("offers Inconclusive as an honest answer when evidence is insufficient", () => {
            // The previous prompt forced the model into a category, which
            // is how it ended up inventing root causes when the evidence
            // didn't support any single conclusion.
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/\*\*Inconclusive\*\*/);
        });

        it("explicitly tells the model not to default to 'fix the test'", () => {
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/do not default to ['"]fix the test['"]/i);
        });

        it("requires the model to justify its attribution with evidence", () => {
            const prompt = buildInterpretationPrompt(failingContext());
            expect(prompt).toMatch(/justify with evidence/i);
        });
    });
});

describe("buildRepairPrompt — known selectors", () => {
    const baseRepairContext = (overrides: Partial<RepairContext> = {}): RepairContext => ({
        testResults: [],
        testCode: "import { test } from '@playwright/test';\ntest('noop', () => {});",
        projectPath: "/tmp/proj",
        ...overrides,
    });

    it("lists indexed selectors so a typo'd locator can be corrected, not invented", () => {
        const prompt = buildRepairPrompt(
            baseRepairContext({
                sourceSelectors: [
                    { kind: "testId", value: "catalog-search", line: 1, attribute: "data-testid" },
                    { kind: "testId", value: "product-price", line: 2, attribute: "data-testid" },
                ],
            }),
        );
        expect(prompt).toMatch(/Known selectors in this app/i);
        expect(prompt).toContain("catalog-search");
        expect(prompt).toContain("product-price");
    });

    it("omits the section when no source selectors are indexed", () => {
        const prompt = buildRepairPrompt(baseRepairContext());
        expect(prompt).not.toContain("Known selectors in this app");
    });
});
