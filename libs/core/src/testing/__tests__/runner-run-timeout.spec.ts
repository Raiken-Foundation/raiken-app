import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the subprocess-kill-vs-per-test-timeout contract (review finding,
 * testing/runner.ts): the whole-run wall-clock budget must be independent
 * of the per-test `--timeout`, so a multi-test spec or a slow-booting
 * webServer is never killed by a budget sized for a single test.
 */

const spawnMock = vi.fn();

vi.mock("../playwright-subprocess", () => ({
    runPlaywrightSubprocess: (...args: unknown[]) => spawnMock(...args),
    // Pass-through so the spec can assert on the options runner.ts built.
    runnerPlaywrightSpawnOptions: (options: unknown) => options,
    playwrightJsonReporterEnv: () => ({}),
}));

vi.mock("../playwright-config", () => ({
    findPlaywrightConfigPath: async () => null,
}));

import { TestRunner } from "../runner";

function completedSubprocess(overrides: Record<string, unknown> = {}) {
    return {
        cancelled: false,
        timedOut: false,
        spawnError: null,
        stdout: "",
        stderr: "boom",
        exitCode: 1,
        ...overrides,
    };
}

beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(completedSubprocess());
});

describe("TestRunner.runTest run-timeout separation", () => {
    it("sizes the subprocess kill budget independently of the per-test --timeout", async () => {
        const runner = new TestRunner("/project");
        await runner.runTest("e2e/login.spec.ts", { timeout: 1000 });

        const options = spawnMock.mock.calls[0]?.[0] as {
            args: string[];
            timeoutMs: number;
        };
        // Default: max(4 x per-test timeout, 5 minutes) — NOT the per-test value.
        expect(options.timeoutMs).toBe(5 * 60_000);
        // The per-test flag stays exactly what the caller asked for.
        const timeoutFlag = options.args.indexOf("--timeout");
        expect(timeoutFlag).toBeGreaterThan(-1);
        expect(options.args[timeoutFlag + 1]).toBe("1000");
    });

    it("honours an explicit runTimeoutMs over the default", async () => {
        const runner = new TestRunner("/project");
        await runner.runTest("e2e/login.spec.ts", {
            timeout: 1000,
            runTimeoutMs: 45_000,
        });

        const options = spawnMock.mock.calls[0]?.[0] as { timeoutMs: number };
        expect(options.timeoutMs).toBe(45_000);
    });

    it("reports the wall-clock budget (not the per-test timeout) when the run is killed", async () => {
        spawnMock.mockResolvedValue(completedSubprocess({ timedOut: true }));
        const runner = new TestRunner("/project");
        const results = await runner.runTest("e2e/login.spec.ts", {
            timeout: 1000,
            runTimeoutMs: 45_000,
        });

        expect(results[0]?.status).toBe("timeout");
        expect(results[0]?.error?.message).toContain("45000ms wall-clock budget");
        expect(results[0]?.error?.message).toContain("per-test timeout stays 1000ms");
        expect(results[0]?.error?.message).not.toContain("Test timed out after 1000ms");
    });
});
