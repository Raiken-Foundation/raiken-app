import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveTestArtifact } from "../save-test-artifact";

/**
 * Pins the save-pipeline validation gate (review finding, testing/
 * save-test-artifact.ts:63-69): saveTestArtifact itself must enforce
 * validateTestCode so no caller can bypass the "single gate every
 * spec-writing path must clear" contract.
 */

let project: string;

beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-save-gate-"));
});

afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
});

const VALID_TEST = `import { test, expect } from "@playwright/test";
test("works", () => {
    expect(1).toBe(1);
});
`;

describe("saveTestArtifact validation gate", () => {
    it("refuses non-parsing content and writes nothing", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            fileName: "broken.spec.ts",
            rawContent: "this is not (( valid code",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("Refusing to save");
        expect(result.message).toContain("does not parse");
        expect(fs.existsSync(path.join(project, "e2e", "broken.spec.ts"))).toBe(false);
    });

    it("refuses leaked tool-call markup even though it parses as JSX", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            fileName: "markup.spec.ts",
            rawContent: `<invoke name="saveFile">test("do", () => {})</invoke>`,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("tool-call markup");
        expect(fs.existsSync(path.join(project, "e2e", "markup.spec.ts"))).toBe(false);
    });

    it("refuses content that parses but contains no test() call", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            fileName: "notatest.spec.ts",
            rawContent: "export const helper = 1;\n",
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("no Playwright test() call");
    });

    it("saves valid generated content through the full pipeline", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            fileName: "good.spec.ts",
            rawContent: VALID_TEST,
        });

        expect(result.success).toBe(true);
        expect(result.filePath).toContain("good.spec.ts");
        const onDisk = fs.readFileSync(path.join(project, "e2e", "good.spec.ts"), "utf-8");
        expect(onDisk).toContain('test("works"');
    });

    it("refuses relativePath targets that are not test files (auto-save guardrail)", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            relativePath: "package.json",
            rawContent: VALID_TEST,
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain("only test files");
        expect(fs.existsSync(path.join(project, "package.json"))).toBe(false);
    });

    it("skipValidation allows explicit user-authored buffers", async () => {
        const result = await saveTestArtifact({
            projectPath: project,
            relativePath: "e2e/notes.spec.ts",
            rawContent: "// scratch notes, intentionally not a test\n",
            skipValidation: true,
        });

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(project, "e2e", "notes.spec.ts"))).toBe(true);
    });
});
