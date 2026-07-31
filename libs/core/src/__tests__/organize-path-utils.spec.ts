import { describe, expect, it } from "vitest";
import { toNativePath, toPosixPath } from "../organize/path-utils";

describe("organize path-utils", () => {
    it("converts backslash-separated (Windows-native) paths to forward slashes", () => {
        expect(toPosixPath("e2e\\auth\\login.spec.ts")).toBe("e2e/auth/login.spec.ts");
    });

    it("leaves already-posix paths untouched", () => {
        expect(toPosixPath("e2e/auth/login.spec.ts")).toBe("e2e/auth/login.spec.ts");
    });

    it("round-trips a posix path through toNativePath and back without loss", () => {
        const posix = "e2e/auth/login.spec.ts";
        expect(toPosixPath(toNativePath(posix))).toBe(posix);
    });
});
