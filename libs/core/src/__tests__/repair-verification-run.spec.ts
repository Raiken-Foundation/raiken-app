/**
 * A repair verification run is evidence, not a convenience: it must not
 * inherit the project's Playwright `retries` (which can launder a fix that
 * only works sometimes into a pass) and it must hold up more than once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestRunOptions, TestRunResult } from "../testing/runner";

const runTest = vi.fn(
    async (_testFile: string, _options?: TestRunOptions): Promise<TestRunResult[]> => [
        { testFile: "e2e/a.spec.ts", testName: "a", status: "passed", duration: 1 },
    ],
);

vi.mock("../testing/runner", () => ({
    TestRunner: class {
        runTest = runTest;
    },
}));

import { createAgentTools, type ToolResult } from "../agent/tools";

function callToolExecute<T>(fn: unknown, args: unknown): Promise<ToolResult<T>> {
    return (fn as (args: unknown) => Promise<ToolResult<T>>)(args);
}

describe("repair verification runs", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-verify-run-"));
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(path.join(projectPath, "e2e", "a.spec.ts"), "test('a', () => {});");
        runTest.mockClear();
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function tools(autoRunTests: boolean) {
        return createAgentTools({
            projectPath,
            autonomy: {
                autoSaveTests: true,
                autoRunTests,
                autoCorrect: "apply",
                autoLearn: "off",
                maxRetries: 2,
            },
        });
    }

    it("disables retries and repeats the spec when verifying a fix", async () => {
        await callToolExecute(tools(true).runTest.execute, {
            testFile: "e2e/a.spec.ts",
            _repairVerification: true,
        });

        expect(runTest).toHaveBeenCalledTimes(1);
        expect(runTest.mock.calls[0]?.[1]).toMatchObject({ retries: 0, repeatEach: 2 });
    });

    // A run the user asked for should behave like their own `playwright test`:
    // their config decides retries, and it runs once.
    it("leaves a user-requested run on the project's own settings", async () => {
        await callToolExecute(tools(true).runTest.execute, { testFile: "e2e/a.spec.ts" });

        const options = runTest.mock.calls[0]?.[1];
        expect(options?.retries).toBeUndefined();
        expect(options?.repeatEach).toBeUndefined();
    });

    // Repair is authorized by `autoCorrect`, not `autoRunTests` — otherwise
    // the loop pauses for approval on every verification and never converges.
    it("verifies without a run approval when autoRunTests is off", async () => {
        const result = await callToolExecute(tools(false).runTest.execute, {
            testFile: "e2e/a.spec.ts",
            _repairVerification: true,
        });

        expect(result.hitlRequired).toBeUndefined();
        expect(runTest).toHaveBeenCalledTimes(1);
    });
});
