/**
 * The `@raiken-unverified` gate: cover stamps the marker on drafts whose
 * review is grounding-driven, and `raiken test` must refuse to run them —
 * an unverified draft that "passes" is a vacuous green. `--allow-unverified`
 * opts out.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTests = vi.fn(async () => ({ success: true, parsedRun: { tests: [] } }));
const listTestFiles = vi.fn(async () => ({ files: [], testDirectory: "e2e" }));

vi.mock("@raiken/core", async (importActual) => {
    const actual = await importActual<typeof import("@raiken/core")>();
    return {
        ...actual,
        createProjectApplication: vi.fn(() => ({
            testing: { runTests, listTestFiles },
        })),
    };
});

const { testCommand, findUnverifiedSpecs } = await import("../test");
const { withThrowExit } = await import("../../repl/exit");

const MARKER = "// @raiken-unverified — drafted by raiken cover";

describe("raiken test unverified gate", () => {
    let projectPath: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        projectPath = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-unverified-")),
        );
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectPath);
        vi.spyOn(console, "log").mockImplementation(() => {});
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
        fs.writeFileSync(
            path.join(projectPath, "e2e", "unverified.spec.ts"),
            `${MARKER}\ntest('x', () => {});\n`,
        );
        fs.writeFileSync(path.join(projectPath, "e2e", "verified.spec.ts"), "test('x', () => {});\n");
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        vi.restoreAllMocks();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("refuses to run a marked spec (exit 1) without starting Playwright", async () => {
        const code = await withThrowExit(() => testCommand("e2e/unverified.spec.ts", {}));
        expect(code).toBe(1);
        expect(runTests).not.toHaveBeenCalled();
    });

    it("the refusal names the marked spec and the remedy", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await withThrowExit(() => testCommand("e2e/unverified.spec.ts", {}));
        const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
        expect(printed).toContain("unverified.spec.ts");
        expect(printed).toContain("@raiken-unverified");
        expect(printed).toContain("--allow-unverified");
    });

    it("runs the marked spec when --allow-unverified is passed", async () => {
        const code = await withThrowExit(() =>
            testCommand("e2e/unverified.spec.ts", { allowUnverified: true }),
        );
        expect(code).toBe(0);
        expect(runTests).toHaveBeenCalledOnce();
    });

    it("runs a spec without the marker", async () => {
        const code = await withThrowExit(() => testCommand("e2e/verified.spec.ts", {}));
        expect(code).toBe(0);
        expect(runTests).toHaveBeenCalledOnce();
    });

    it("scans the whole suite when no file is given", async () => {
        listTestFiles.mockResolvedValue({
            files: [
                { path: "e2e/unverified.spec.ts" },
                { path: "e2e/verified.spec.ts" },
            ],
            testDirectory: "e2e",
        });
        const code = await withThrowExit(() => testCommand(undefined, {}));
        expect(code).toBe(1);
        expect(runTests).not.toHaveBeenCalled();
    });
});

describe("findUnverifiedSpecs", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-find-unverified-"));
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("checks exactly the files the run will touch", async () => {
        fs.writeFileSync(path.join(projectPath, "e2e", "a.spec.ts"), `${MARKER}\n`);
        fs.writeFileSync(path.join(projectPath, "e2e", "b.spec.ts"), "no marker\n");
        const input = { testFiles: ["e2e/a.spec.ts", "e2e/b.spec.ts"] };
        const marked = await findUnverifiedSpecs(projectPath, undefined, input);
        expect(marked).toEqual(["e2e/a.spec.ts"]);
    });
});
