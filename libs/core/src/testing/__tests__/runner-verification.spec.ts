import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestRunner, type TestRunOptions, type TestRunResult } from "../runner";

vi.mock("node:child_process", () => ({
    spawn: vi.fn(),
}));

vi.mock("../process-tree", () => ({
    killProcessTree: vi.fn(),
}));

vi.mock("../playwright-config", () => ({
    findPlaywrightConfigPath: vi.fn(async () => null),
}));

interface Attempt {
    status: string;
    duration?: number;
    error?: { message?: string };
}

/** One spec with one `tests` entry per repetition, each holding its retries. */
function report(specTitle: string, repetitions: Attempt[][]) {
    return {
        suites: [
            {
                specs: [
                    {
                        title: specTitle,
                        tests: repetitions.map((results) => ({ results })),
                    },
                ],
            },
        ],
    };
}

/**
 * How `--repeat-each` really arrives: not as extra attempts inside a spec, but
 * as one duplicate spec entry per repetition, all sharing the same title.
 * Captured from a live `playwright test --repeat-each=2` JSON report.
 */
function repeatedReport(entries: Array<{ title: string; attempts: Attempt[] }>) {
    return {
        suites: [
            {
                title: "example.spec.ts",
                specs: entries.map(({ title, attempts }) => ({
                    title,
                    tests: [{ results: attempts }],
                })),
            },
        ],
    };
}

/** Drive a mocked Playwright process that prints `json` and exits `code`. */
async function run(
    json: unknown,
    options: TestRunOptions = {},
    code = 0,
): Promise<{ results: TestRunResult[]; args: string[] }> {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
    };
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new TestRunner(os.tmpdir());
    const promise = runner.runTest("e2e/example.spec.ts", { timeout: 1000, ...options });
    // Let runTest reach its spawn call before feeding the process output.
    await Promise.resolve();
    await Promise.resolve();
    child.stdout.emit("data", JSON.stringify(json));
    child.emit("close", code);

    const results = await promise;
    const args = (vi.mocked(spawn).mock.calls[0]?.[1] ?? []) as string[];
    return { results, args };
}

const PASS: Attempt = { status: "passed", duration: 10 };
const FAIL: Attempt = { status: "failed", duration: 5, error: { message: "modal intercepted" } };

describe("TestRunner verification runs", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("pins retries and repetitions on the command line when asked", async () => {
        const { args } = await run(report("a", [[PASS]]), { retries: 0, repeatEach: 2 });
        expect(args).toContain("--retries=0");
        expect(args).toContain("--repeat-each=2");
    });

    it("leaves the project config in charge when neither is requested", async () => {
        const { args } = await run(report("a", [[PASS]]));
        expect(args.some((arg) => arg.startsWith("--retries"))).toBe(false);
        expect(args.some((arg) => arg.startsWith("--repeat-each"))).toBe(false);
    });

    it("reports a spec that passed then failed across repetitions as flaky", async () => {
        const { results } = await run(report("deletes a workspace", [[PASS], [FAIL]]));
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("flaky");
        // The repair loop needs the reason, not just the verdict.
        expect(results[0].error?.message).toBe("modal intercepted");
    });

    // The regression: a repair "passed" verification because Playwright
    // retried it, and failed on the next dashboard run.
    it("reports a spec that only passed on retry as flaky", async () => {
        const { results } = await run(report("deletes a workspace", [[FAIL, PASS]]));
        expect(results[0].status).toBe("flaky");
        expect(results[0].error?.message).toBe("modal intercepted");
    });

    it("reports a spec that passed every repetition as passed", async () => {
        const { results } = await run(report("signs in", [[PASS], [PASS]]));
        expect(results[0].status).toBe("passed");
        expect(results[0].error).toBeUndefined();
    });

    it("reports a spec that failed every repetition as failed", async () => {
        const { results } = await run(report("signs in", [[FAIL], [FAIL]]), {}, 1);
        expect(results[0].status).toBe("failed");
    });

    it("keeps a timeout distinguishable from an assertion failure", async () => {
        const { results } = await run(
            report("signs in", [[{ status: "timedOut", duration: 30_000 }]]),
            {},
            1,
        );
        expect(results[0].status).toBe("timeout");
    });

    it("still reports genuinely skipped specs as skipped", async () => {
        const { results } = await run(report("signs in", [[{ status: "skipped" }]]));
        expect(results[0].status).toBe("skipped");
    });

    // Caught against a real Playwright run: repetitions land in separate spec
    // entries, so an unmerged report claimed "1 passed, 1 failed" for a single
    // test and never reached the flaky verdict verification depends on.
    describe("repetitions reported as separate specs", () => {
        it("merges a mixed pair into one flaky result", async () => {
            const { results } = await run(
                repeatedReport([
                    { title: "deletes a workspace", attempts: [PASS] },
                    { title: "always passes", attempts: [PASS] },
                    { title: "deletes a workspace", attempts: [FAIL] },
                    { title: "always passes", attempts: [PASS] },
                ]),
                { retries: 0, repeatEach: 2 },
                1,
            );

            expect(results.map((r) => `${r.testName}:${r.status}`)).toEqual([
                "deletes a workspace:flaky",
                "always passes:passed",
            ]);
            expect(results[0].error?.message).toBe("modal intercepted");
            // Both repetitions of the test, not just the one reported first.
            expect(results[0].duration).toBe(15);
        });

        it("keeps a consistently failing test failed", async () => {
            const { results } = await run(
                repeatedReport([
                    { title: "signs in", attempts: [FAIL] },
                    { title: "signs in", attempts: [FAIL] },
                ]),
                { retries: 0, repeatEach: 2 },
                1,
            );
            expect(results).toHaveLength(1);
            expect(results[0].status).toBe("failed");
        });

        it("keeps a consistently passing test passed and error-free", async () => {
            const { results } = await run(
                repeatedReport([
                    { title: "signs in", attempts: [PASS] },
                    { title: "signs in", attempts: [PASS] },
                ]),
                { retries: 0, repeatEach: 2 },
            );
            expect(results).toHaveLength(1);
            expect(results[0].status).toBe("passed");
            expect(results[0].error).toBeUndefined();
        });

        it("leaves distinct tests alone", async () => {
            const { results } = await run(
                repeatedReport([
                    { title: "signs in", attempts: [PASS] },
                    { title: "signs out", attempts: [PASS] },
                ]),
            );
            expect(results.map((r) => r.testName)).toEqual(["signs in", "signs out"]);
        });
    });
});
