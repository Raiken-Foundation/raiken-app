import { describe, expect, it } from "vitest";
import { buildTestRunArgs, type TestExecutionInput } from "../testing/test-execution-service";

function build(input: TestExecutionInput, targets: string[] = []): string[] {
    return buildTestRunArgs({ targets, input, configPath: "/proj/playwright.config.ts" });
}

describe("buildTestRunArgs", () => {
    it("matches the historical default invocation", () => {
        expect(build({}, ["e2e/login.spec.ts"])).toEqual([
            "playwright",
            "test",
            "e2e/login.spec.ts",
            "--workers=1",
            "--reporter=json",
            "--config",
            "/proj/playwright.config.ts",
        ]);
    });

    it("passes multiple targets through (quarantine filtering)", () => {
        const args = build({}, ["e2e/a.spec.ts", "e2e/b.spec.ts"]);
        expect(args.slice(2, 4)).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    });

    it("maps every CLI-exposed flag onto a Playwright argument", () => {
        const args = build(
            {
                testName: "login",
                workers: 4,
                headed: true,
                project: "firefox",
                retries: 2,
                updateSnapshots: true,
            },
            ["e2e"],
        );
        expect(args).toContain("-g");
        expect(args[args.indexOf("-g") + 1]).toBe("login");
        expect(args).toContain("--workers=4");
        expect(args).toContain("--headed");
        expect(args).toContain("--project=firefox");
        expect(args).toContain("--retries=2");
        expect(args).toContain("--update-snapshots");
    });

    it("adds --list in list-only mode and keeps the json reporter", () => {
        const args = build({ listOnly: true });
        expect(args).toContain("--list");
        expect(args).toContain("--reporter=json");
    });

    it("appends extra args verbatim, after ours", () => {
        const args = build({ extraArgs: ["--shard=1/3"] });
        expect(args.at(-1)).toBe("--shard=1/3");
    });

    it("ignores negative retries instead of emitting an invalid flag", () => {
        expect(build({ retries: -1 })).not.toContain("--retries=-1");
    });
});
