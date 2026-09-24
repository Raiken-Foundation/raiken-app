import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { CodeGraphDB } from "../../database/db";
import { recordRunOutcomes } from "../record-outcomes";

it.each([
    false,
    true,
])("keeps the failure across colliding legacy identities (reverse=%s)", (reverse) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-outcome-memory-"));
    try {
        const rows = [
            {
                testFile: "e2e/login.spec.ts",
                testName: "login",
                status: "failed" as const,
                errorMessage: "Chromium failed",
            },
            { testFile: "e2e/login.spec.ts", testName: "login", status: "passed" as const },
        ];
        recordRunOutcomes(project, reverse ? rows.reverse() : rows);
        const db = new CodeGraphDB(project);
        try {
            expect(db.getRecentFailures()).toEqual([
                expect.objectContaining({
                    testFile: "e2e/login.spec.ts",
                    testName: "login",
                    errorMessage: "Chromium failed",
                }),
            ]);
        } finally {
            db.close();
        }
        recordRunOutcomes(project, [
            { testFile: "e2e/login.spec.ts", testName: "login", status: "passed" },
        ]);
        const next = new CodeGraphDB(project);
        try {
            expect(next.getRecentFailures()).toEqual([]);
        } finally {
            next.close();
        }
    } finally {
        fs.rmSync(project, { recursive: true, force: true });
    }
});
