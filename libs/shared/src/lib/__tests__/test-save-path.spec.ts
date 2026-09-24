import { describe, expect, it } from "vitest";
import { splitTestSavePath } from "../test-save-path";

describe("splitTestSavePath", () => {
    it("splits nested POSIX and Windows-style paths", () => {
        expect(splitTestSavePath("e2e/auth/login.spec.ts")).toEqual({
            fileName: "login.spec.ts",
            testDir: "e2e/auth",
        });
        expect(splitTestSavePath("e2e\\auth\\login.spec.ts")).toEqual({
            fileName: "login.spec.ts",
            testDir: "e2e/auth",
        });
    });

    it("uses the caller's default directory for a basename", () => {
        expect(splitTestSavePath("login.spec.ts", "e2e")).toEqual({
            fileName: "login.spec.ts",
            testDir: "e2e",
        });
    });
});
