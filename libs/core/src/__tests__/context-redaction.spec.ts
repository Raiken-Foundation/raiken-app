import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeGraphDB } from "../database/db";
import { writeProjectContext } from "../context/builder";

/**
 * Pins the ctx.md secret-redaction + markdown-escaping contract (review
 * finding, context/builder.ts:206-211): raiken.ctx.md is built to be handed
 * to external IDE AI agents, so raw Playwright error text (URLs with
 * ?token=, auth headers) must be redacted and page-controlled names must
 * not be able to break out of the table's code spans.
 */

let projectPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ctx-redaction-"));
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
});

describe("writeProjectContext redaction", () => {
    it("redacts secrets in failure messages and flattens/escapes table cells", async () => {
        const db = new CodeGraphDB(projectPath);
        try {
            db.upsertRunOutcome({
                testFile: "e2e/login.spec.ts",
                testName: "login `whoami` pipe | attempt",
                status: "failed",
                errorMessage:
                    "GET http://app.local/session?token=supersecret123 failed\nBearer abc.def.ghi\nsecond line",
            });
        } finally {
            db.close();
        }

        const result = await writeProjectContext({
            projectPath,
            outputPath: "raiken.ctx.md",
            includeImpact: false,
        });

        const content = fs.readFileSync(path.join(projectPath, "raiken.ctx.md"), "utf-8");

        // Secrets never reach the AI-facing file.
        expect(content).not.toContain("supersecret123");
        expect(content).toContain("token=[redacted]");
        expect(content).not.toContain("Bearer abc.def.ghi");

        // Page-controlled test names cannot break out of a code span or the
        // table row: backticks stripped, pipes escaped, newlines flattened.
        expect(content).not.toContain("`whoami`");
        expect(content).not.toMatch(/\| login [^|]*\|[^|]*\|[^|]*\|[^|]*\|/);
        expect(content).not.toMatch(/second line\r?\n\|/);
        expect(result.outputPath).toContain("raiken.ctx.md");
    });
});
