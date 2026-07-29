import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../process-tree";
import { TestRunner } from "../runner";

vi.mock("node:child_process", () => ({
    spawn: vi.fn(),
}));

vi.mock("../process-tree", () => ({
    killProcessTree: vi.fn(),
}));

vi.mock("../playwright-config", () => ({
    findPlaywrightConfigPath: vi.fn(async () => null),
}));

function mockChildProcess(pid = 4242) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
    };
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
}

describe("TestRunner abort handling", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns a cancelled result when the signal is already aborted", async () => {
        const runner = new TestRunner(os.tmpdir());
        const controller = new AbortController();
        controller.abort();

        const results = await runner.runTest("e2e/example.spec.ts", {
            signal: controller.signal,
        });

        expect(results).toEqual([
            expect.objectContaining({
                status: "error",
                error: { message: "Operation cancelled" },
            }),
        ]);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("kills the process tree when the signal aborts mid-run", async () => {
        const child = mockChildProcess();
        vi.mocked(spawn).mockReturnValue(child as never);

        const runner = new TestRunner(path.join(os.tmpdir(), "raiken-runner-abort"));
        const controller = new AbortController();
        const runPromise = runner.runTest("e2e/example.spec.ts", {
            signal: controller.signal,
            timeout: 60_000,
        });

        controller.abort();
        const results = await runPromise;

        expect(killProcessTree).toHaveBeenCalledWith(4242, "SIGTERM");
        expect(results).toEqual([
            expect.objectContaining({
                status: "error",
                error: { message: "Operation cancelled" },
            }),
        ]);
    });
});
