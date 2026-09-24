import { describe, expect, it } from "vitest";
import { getDiffMetaLabel, shouldShowDiff } from "../helpers";
import { getLanguage } from "../monaco-config";
import type { DiffReview, TestFile } from "../types";

const baseFile: TestFile = {
    id: "1",
    name: "login.spec.ts",
    path: "e2e/login.spec.ts",
    content: "test('login')",
    status: "pending",
};

const diffReview: DiffReview = {
    fileName: "login.spec.ts",
    targetPath: "e2e/login.spec.ts",
    original: "old",
    proposed: "new",
    editCount: 2,
    mode: "edits",
    matchFailed: false,
};

describe("code editor diff visibility", () => {
    it("shows diff only on the target file tab", () => {
        expect(shouldShowDiff(diffReview, baseFile)).toBe(true);
        expect(shouldShowDiff(diffReview, { ...baseFile, path: "e2e/other.spec.ts" })).toBe(false);
    });

    it("shows diff when no file is active", () => {
        expect(shouldShowDiff(diffReview, undefined)).toBe(true);
    });

    it("hides diff when no review is pending", () => {
        expect(shouldShowDiff(null, baseFile)).toBe(false);
    });
});

describe("code editor diff meta label", () => {
    it("describes section edits", () => {
        expect(getDiffMetaLabel(diffReview)).toBe("2 section edits");
        expect(getDiffMetaLabel({ ...diffReview, editCount: 1 })).toBe("1 section edit");
    });

    it("describes full rewrites", () => {
        expect(getDiffMetaLabel({ ...diffReview, mode: "full", editCount: null })).toBe(
            "full rewrite",
        );
    });
});

describe("monaco language detection", () => {
    it("maps common spec extensions to typescript", () => {
        expect(getLanguage("login.spec.ts")).toBe("typescript");
        expect(getLanguage("component.tsx")).toBe("typescript");
    });

    it("falls back to typescript for unknown extensions", () => {
        expect(getLanguage("notes.txt")).toBe("typescript");
    });
});
