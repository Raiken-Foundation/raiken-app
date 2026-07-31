import { describe, expect, it } from "vitest";
import { isQuarantinedSpec, partitionQuarantinedSpecs } from "../testing/quarantine";

describe("isQuarantinedSpec", () => {
    const list = ["e2e/login.spec.ts", "flaky.spec.ts"];

    it("matches exact project-relative paths", () => {
        expect(isQuarantinedSpec("e2e/login.spec.ts", list)).toBe(true);
    });

    it("matches a bare filename anywhere in the tree", () => {
        expect(isQuarantinedSpec("e2e/auth/flaky.spec.ts", list)).toBe(true);
    });

    it("does not match partial filenames", () => {
        expect(isQuarantinedSpec("e2e/flaky.spec.ts.bak", list)).toBe(false);
        expect(isQuarantinedSpec("e2e/other-login.spec.ts", list)).toBe(false);
    });

    it("tolerates windows separators and ./ prefixes", () => {
        expect(isQuarantinedSpec("e2e\\auth\\flaky.spec.ts", list)).toBe(true);
        expect(isQuarantinedSpec("./e2e/login.spec.ts", list)).toBe(true);
        expect(isQuarantinedSpec("e2e/login.spec.ts", ["./e2e/login.spec.ts"])).toBe(true);
    });
});

describe("partitionQuarantinedSpecs", () => {
    it("splits preserving order in both buckets", () => {
        const { included, excluded } = partitionQuarantinedSpecs(
            ["e2e/a.spec.ts", "e2e/b.spec.ts", "e2e/c.spec.ts"],
            ["e2e/b.spec.ts"],
        );
        expect(included).toEqual(["e2e/a.spec.ts", "e2e/c.spec.ts"]);
        expect(excluded).toEqual(["e2e/b.spec.ts"]);
    });

    it("keeps everything when the quarantine list is empty", () => {
        const { included, excluded } = partitionQuarantinedSpecs(["e2e/a.spec.ts"], []);
        expect(included).toEqual(["e2e/a.spec.ts"]);
        expect(excluded).toEqual([]);
    });
});
