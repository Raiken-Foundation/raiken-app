import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getRaikenVersion } from "../version";
import { RAIKEN_VERSION } from "../version.constant";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../");
const CLI_PACKAGE = path.join(REPO_ROOT, "apps/cli/package.json");

describe("getRaikenVersion browser entry", () => {
    it("returns the shared version constant without Node fs/path imports", () => {
        expect(getRaikenVersion()).toBe(RAIKEN_VERSION);
    });

    it("matches apps/cli/package.json version", () => {
        const pkg = JSON.parse(fs.readFileSync(CLI_PACKAGE, "utf-8")) as { version: string };
        expect(RAIKEN_VERSION).toBe(pkg.version);
        expect(getRaikenVersion()).toBe(pkg.version);
    });

    it("version.ts does not import node:fs or node:path", () => {
        const source = fs.readFileSync(path.join(import.meta.dirname, "../version.ts"), "utf-8");
        expect(source).not.toMatch(/node:fs|node:path|require\(/);
    });
});
