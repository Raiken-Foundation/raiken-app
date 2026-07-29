import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getRaikenVersion } from "../version";

describe("getRaikenVersion", () => {
    it("matches the published CLI package version", () => {
        const cliPackagePath = path.resolve(__dirname, "../../../../../apps/cli/package.json");
        const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, "utf-8")) as {
            version: string;
        };

        expect(getRaikenVersion()).toBe(cliPackage.version);
    });
});
