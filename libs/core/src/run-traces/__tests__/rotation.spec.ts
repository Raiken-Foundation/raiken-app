import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateTraceFiles } from "../rotation";

describe("rotateTraceFiles", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-trace-rot-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("deletes oldest files beyond max count", () => {
        for (let i = 0; i < 5; i++) {
            const file = path.join(dir, `2025-01-0${i}-agent-abc${i}.jsonl`);
            fs.writeFileSync(file, "{}");
            const past = Date.now() - (5 - i) * 60_000;
            fs.utimesSync(file, past / 1000, past / 1000);
        }

        const result = rotateTraceFiles(dir, {
            maxFiles: 2,
            maxTotalBytes: 1024 * 1024,
            maxAgeMs: 0,
        });
        expect(result.remainingFiles).toBeLessThanOrEqual(2);
        expect(result.deleted.length).toBeGreaterThan(0);
    });

    it("evicts by total byte budget", () => {
        for (let i = 0; i < 3; i++) {
            fs.writeFileSync(path.join(dir, `trace-${i}.jsonl`), "x".repeat(500));
        }
        const result = rotateTraceFiles(dir, { maxFiles: 100, maxTotalBytes: 600, maxAgeMs: 0 });
        expect(result.remainingBytes).toBeLessThanOrEqual(600);
    });
});
