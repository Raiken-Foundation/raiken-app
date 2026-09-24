import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    applyAlignBaseUrlPort,
    applyWidenTestMatch,
    isFixableDoctorFinding,
} from "../doctor/fixes";
import { readPlaywrightBaseURL, readPlaywrightTestMatch } from "../testing/playwright-config";

describe("doctor mechanical fixes", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-doctor-fix-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("widens a restrictive testMatch", async () => {
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { testDir: './e2e', testMatch: ['workflows.spec.ts'] };\n`,
        );
        const result = await applyWidenTestMatch(projectDir);
        expect(result.applied).toBe(true);
        expect(await readPlaywrightTestMatch(projectDir)).toEqual(["**/*.spec.ts"]);
        expect(isFixableDoctorFinding({ rule: "testmatch-restrictive" } as never)).toBe(true);
    });

    it("aligns baseURL with a detected vite port", async () => {
        fs.writeFileSync(
            path.join(projectDir, "package.json"),
            JSON.stringify({
                scripts: { dev: "vite --port 5173" },
            }),
        );
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:3000' } };\n`,
        );
        const result = await applyAlignBaseUrlPort(projectDir);
        expect(result.applied).toBe(true);
        expect(await readPlaywrightBaseURL(projectDir)).toBe("http://localhost:5173");
    });
});
