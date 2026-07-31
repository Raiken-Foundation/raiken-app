import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type CorrelationContext,
    correlationFields,
    runWithCorrelationContext,
} from "../../observability/context";

vi.mock("../../operations/project-operation", () => ({
    acquireProjectOperation: vi.fn(async () => ({
        manifest: { kind: "test", pid: 42, startedAt: 200 },
        release: vi.fn(async () => undefined),
    })),
}));

vi.mock("../playwright-config", () => ({
    findPlaywrightConfigPath: vi.fn(async () => "/tmp/playwright.config.ts"),
    writePlaywrightConfig: vi.fn(),
}));

vi.mock("../playwright-subprocess", () => ({
    playwrightJsonReporterEnv: vi.fn(() => ({})),
    runnerPlaywrightSpawnOptions: vi.fn((opts: unknown) => opts),
    runPlaywrightSubprocess: vi.fn(async () => ({
        stdout: '{"suites":[]}',
        stderr: "",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        spawnError: null,
    })),
}));

import { TestExecutionService } from "../test-execution-service";

describe("detached test execution correlation", () => {
    let projectPath: string;
    let service: TestExecutionService;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-detached-"));
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
        service = new TestExecutionService();
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it("retains merged correlation after caller scope exits", async () => {
        let correlationDuringRun: CorrelationContext | undefined;
        const { runPlaywrightSubprocess } = await import("../playwright-subprocess");
        vi.mocked(runPlaywrightSubprocess).mockImplementation(async () => {
            correlationDuringRun = correlationFields();
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
                stdout: '{"suites":[]}',
                stderr: "",
                exitCode: 0,
                cancelled: false,
                timedOut: false,
                spawnError: null,
            };
        });

        let detachedPromise: Promise<unknown> | undefined;
        await runWithCorrelationContext(
            { correlationId: "caller-test-req", projectPath, requestId: "req-test-1" },
            async () => {
                detachedPromise = service.run(projectPath, { testFile: "e2e/example.spec.ts" });
            },
        );

        expect(correlationFields()).toEqual({});
        await detachedPromise;
        expect(correlationDuringRun?.correlationId).toBe("caller-test-req");
        expect(correlationDuringRun?.requestId).toBe("req-test-1");
        expect(correlationDuringRun?.runId).toEqual(expect.any(String));
    });

    it("isolates parallel detached test runs", async () => {
        const captured: CorrelationContext[] = [];
        const { runPlaywrightSubprocess } = await import("../playwright-subprocess");
        vi.mocked(runPlaywrightSubprocess).mockImplementation(async () => {
            captured.push({ ...correlationFields() });
            await new Promise((resolve) => setTimeout(resolve, 5));
            return {
                stdout: '{"suites":[]}',
                stderr: "",
                exitCode: 0,
                cancelled: false,
                timedOut: false,
                spawnError: null,
            };
        });

        const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-a-"));
        const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-b-"));
        fs.mkdirSync(path.join(projectA, ".raiken"), { recursive: true });
        fs.mkdirSync(path.join(projectB, ".raiken"), { recursive: true });
        const serviceA = new TestExecutionService();
        const serviceB = new TestExecutionService();

        try {
            let promiseA: Promise<unknown> | undefined;
            let promiseB: Promise<unknown> | undefined;
            await runWithCorrelationContext(
                { correlationId: "test-left", projectPath: projectA },
                async () => {
                    promiseA = serviceA.run(projectA, { testFile: "a.spec.ts" });
                },
            );
            await runWithCorrelationContext(
                { correlationId: "test-right", projectPath: projectB },
                async () => {
                    promiseB = serviceB.run(projectB, { testFile: "b.spec.ts" });
                },
            );

            await Promise.all([promiseA, promiseB]);
            expect(captured.map((entry) => entry.correlationId).sort()).toEqual([
                "test-left",
                "test-right",
            ]);
            expect(captured[0]?.runId).not.toBe(captured[1]?.runId);
        } finally {
            fs.rmSync(projectA, { recursive: true, force: true });
            fs.rmSync(projectB, { recursive: true, force: true });
        }
    });
});
