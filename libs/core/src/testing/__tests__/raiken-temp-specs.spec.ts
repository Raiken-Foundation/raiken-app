import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    RAIKEN_AUTH_SPEC_PATTERN,
    RAIKEN_RUN_SPEC_PATTERN,
    sweepStaleRaikenTempSpecs,
} from "../raiken-temp-specs";

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sweepStaleRaikenTempSpecs", () => {
    it("removes only matching stale files inside the contained root", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-sweep-"));
        dirs.push(root);
        const testDir = path.join(root, "e2e");
        await fs.mkdir(testDir, { recursive: true });

        const staleTs = Date.now() - 20 * 60 * 1000;
        const freshTs = Date.now();
        await fs.writeFile(path.join(testDir, `scratch.raiken-run-${staleTs}.spec.ts`), "// stale");
        await fs.writeFile(path.join(testDir, `scratch.raiken-run-${freshTs}.spec.ts`), "// fresh");
        await fs.writeFile(path.join(testDir, "real.spec.ts"), "// keep");

        await sweepStaleRaikenTempSpecs({
            directory: testDir,
            containedRoot: root,
            pattern: RAIKEN_RUN_SPEC_PATTERN,
            maxAgeMs: 10 * 60 * 1000,
        });

        const remaining = await fs.readdir(testDir);
        expect(remaining).toContain(`scratch.raiken-run-${freshTs}.spec.ts`);
        expect(remaining).toContain("real.spec.ts");
        expect(remaining).not.toContain(`scratch.raiken-run-${staleTs}.spec.ts`);
    });

    it("refuses to sweep outside the contained root", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-sweep-out-"));
        dirs.push(root);
        const outside = path.join(os.tmpdir(), "raiken-outside-sweep");
        await fs.mkdir(outside, { recursive: true });
        dirs.push(outside);

        await expect(
            sweepStaleRaikenTempSpecs({
                directory: outside,
                containedRoot: root,
                pattern: RAIKEN_AUTH_SPEC_PATTERN,
                maxAgeMs: 1000,
            }),
        ).rejects.toThrow("contained root");
    });
});
