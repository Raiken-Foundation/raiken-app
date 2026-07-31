import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertContainedTraceDir, rotateTraceFiles } from "../rotation";

describe("trace rotation containment", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-trace-root-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("rejects deleting files outside the project traces root", () => {
        const tracesDir = path.join(projectPath, ".raiken", "traces");
        fs.mkdirSync(tracesDir, { recursive: true });
        const outside = path.join(projectPath, "outside.jsonl");
        fs.writeFileSync(outside, "{}");

        expect(() =>
            assertContainedTraceDir(path.join(projectPath, ".raiken"), projectPath),
        ).toThrow(/traces/);

        const result = rotateTraceFiles(tracesDir, { maxFiles: 0, maxAgeMs: 0 }, projectPath);
        expect(fs.existsSync(outside)).toBe(true);
        expect(result.deleted.every((file) => file.startsWith(tracesDir))).toBe(true);
    });
});
