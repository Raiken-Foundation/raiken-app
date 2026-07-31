import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlaywrightSubprocess } from "../playwright-subprocess";
import {
    createPlaywrightSubprocessRuntime,
    customLoginPlaywrightSpawnOptions,
    runnerPlaywrightSpawnOptions,
} from "../playwright-subprocess-runtime";
import { killProcessTree } from "../process-tree";

vi.mock("node:child_process", () => ({
    spawn: vi.fn(),
}));

vi.mock("../process-tree", () => ({
    killProcessTree: vi.fn(),
}));

function mockChild(pid = 4242) {
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

describe("playwright subprocess runtime", () => {
    it("uses npx.cmd without shell on Windows", () => {
        const runtime = createPlaywrightSubprocessRuntime("win32");
        expect(runtime.resolveCommand({ shell: false })).toBe("npx.cmd");
        expect(runtime.spawnDetached).toBe(false);
    });

    it("uses npx with shell on Windows", () => {
        const runtime = createPlaywrightSubprocessRuntime("win32");
        expect(runtime.resolveCommand({ shell: true })).toBe("npx");
    });

    it("uses npx without shell on POSIX", () => {
        const runtime = createPlaywrightSubprocessRuntime("linux");
        expect(runtime.resolveCommand({ shell: false })).toBe("npx");
        expect(runtime.spawnDetached).toBe(true);
    });
});

describe("playwright subprocess adapters", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("runner adapter spawns npx.cmd without shell on Windows", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const runtime = createPlaywrightSubprocessRuntime("win32");

        const promise = runPlaywrightSubprocess(
            runnerPlaywrightSpawnOptions({
                cwd: os.tmpdir(),
                args: ["playwright", "test"],
                runtime,
            }),
        );
        await Promise.resolve();
        child.emit("close", 0);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            "npx.cmd",
            ["playwright", "test"],
            expect.objectContaining({ shell: false, detached: false }),
        );
    });

    it("runner adapter never spawns a shell, so spec paths cannot inject commands", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const runtime = createPlaywrightSubprocessRuntime("linux");
        const hostileSpec = "e2e/a.spec.ts; touch /tmp/pwned";

        const promise = runPlaywrightSubprocess(
            runnerPlaywrightSpawnOptions({
                cwd: os.tmpdir(),
                args: ["playwright", "test", hostileSpec],
                runtime,
            }),
        );
        await Promise.resolve();
        child.emit("close", 0);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            "npx",
            ["playwright", "test", hostileSpec],
            expect.objectContaining({ shell: false }),
        );
    });

    it("custom-login adapter spawns npx.cmd without shell on Windows", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const runtime = createPlaywrightSubprocessRuntime("win32");

        const promise = runPlaywrightSubprocess(
            customLoginPlaywrightSpawnOptions({
                cwd: os.tmpdir(),
                args: ["--no-install", "playwright", "test", "auth.spec.ts"],
                runtime,
            }),
        );
        await Promise.resolve();
        child.emit("close", 0);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            "npx.cmd",
            ["--no-install", "playwright", "test", "auth.spec.ts"],
            expect.objectContaining({ shell: false, detached: false }),
        );
    });

    it("custom-login adapter spawns npx without shell on POSIX", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const runtime = createPlaywrightSubprocessRuntime("darwin");

        const promise = runPlaywrightSubprocess(
            customLoginPlaywrightSpawnOptions({
                cwd: os.tmpdir(),
                args: ["--no-install", "playwright", "test", "auth.spec.ts"],
                runtime,
            }),
        );
        await Promise.resolve();
        child.emit("close", 0);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            "npx",
            ["--no-install", "playwright", "test", "auth.spec.ts"],
            expect.objectContaining({ shell: false, detached: true }),
        );
    });

    it("runner adapter spawns detached on POSIX", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const runtime = createPlaywrightSubprocessRuntime("linux");

        const promise = runPlaywrightSubprocess(
            runnerPlaywrightSpawnOptions({
                cwd: os.tmpdir(),
                args: ["playwright", "test"],
                runtime,
            }),
        );
        await Promise.resolve();
        child.emit("close", 0);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
            "npx",
            ["playwright", "test"],
            expect.objectContaining({ shell: false, detached: true }),
        );
    });
});

describe("runPlaywrightSubprocess", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns immediately when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await runPlaywrightSubprocess({
            cwd: os.tmpdir(),
            args: ["playwright", "test"],
            signal: controller.signal,
        });
        expect(result.cancelled).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("captures stdout/stderr and exit code", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);

        const promise = runPlaywrightSubprocess({
            cwd: os.tmpdir(),
            args: ["playwright", "test"],
        });
        await Promise.resolve();
        child.stdout.emit("data", '{"suites":[]}');
        child.stderr.emit("data", "warn");
        child.emit("close", 0);

        const result = await promise;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("suites");
        expect(result.stderr).toBe("warn");
    });

    it("kills the process tree on abort", async () => {
        const child = mockChild(777);
        vi.mocked(spawn).mockReturnValue(child as never);
        const controller = new AbortController();

        const promise = runPlaywrightSubprocess({
            cwd: os.tmpdir(),
            args: ["playwright", "test"],
            signal: controller.signal,
        });
        await Promise.resolve();
        controller.abort();
        const result = await promise;

        expect(killProcessTree).toHaveBeenCalledWith(777, "SIGTERM");
        expect(result.cancelled).toBe(true);
    });

    it("terminates on timeout", async () => {
        vi.useFakeTimers();
        const child = mockChild(888);
        vi.mocked(spawn).mockReturnValue(child as never);

        const promise = runPlaywrightSubprocess({
            cwd: os.tmpdir(),
            args: ["playwright", "test"],
            timeoutMs: 1000,
            timeoutGraceMs: 0,
        });
        await Promise.resolve();
        vi.advanceTimersByTime(1000);
        const result = await promise;

        expect(killProcessTree).toHaveBeenCalledWith(888, "SIGTERM");
        expect(result.timedOut).toBe(true);
        vi.useRealTimers();
    });

    it("settles only once when close follows abort", async () => {
        const child = mockChild();
        vi.mocked(spawn).mockReturnValue(child as never);
        const controller = new AbortController();

        const promise = runPlaywrightSubprocess({
            cwd: os.tmpdir(),
            args: ["playwright", "test"],
            signal: controller.signal,
        });
        await Promise.resolve();
        controller.abort();
        child.emit("close", 1);
        const result = await promise;
        expect(result.cancelled).toBe(true);
    });
});
