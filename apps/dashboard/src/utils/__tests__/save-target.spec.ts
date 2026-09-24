import { describe, expect, it } from "vitest";
import { shouldAvoidOverwrite } from "../save-target";

describe("shouldAvoidOverwrite", () => {
    it("dedupes an untouched auto-suggested path so unrelated specs can't clobber each other", () => {
        expect(
            shouldAvoidOverwrite({
                suggestedPath: "e2e/login.spec.ts",
                requestedPath: "e2e/login.spec.ts",
                overwriteTarget: undefined,
            }),
        ).toBe(true);
    });

    // The reported regression: an update to an existing spec landed beside it
    // as `login-2.spec.ts`, leaving the file the user meant to fix untouched.
    it("overwrites when the agent targeted an existing spec", () => {
        expect(
            shouldAvoidOverwrite({
                suggestedPath: "e2e/login.spec.ts",
                requestedPath: "e2e/login.spec.ts",
                overwriteTarget: true,
            }),
        ).toBe(false);
    });

    it("overwrites a path the user typed into the approval card", () => {
        expect(
            shouldAvoidOverwrite({
                suggestedPath: "e2e/raiken-test.spec.ts",
                requestedPath: "e2e/login.spec.ts",
                overwriteTarget: false,
            }),
        ).toBe(false);
    });

    it("treats whitespace-only differences as no edit", () => {
        expect(
            shouldAvoidOverwrite({
                suggestedPath: "e2e/login.spec.ts",
                requestedPath: "  e2e/login.spec.ts  ",
                overwriteTarget: false,
            }),
        ).toBe(true);
    });

    it("dedupes when there was no suggestion to compare against", () => {
        expect(
            shouldAvoidOverwrite({
                suggestedPath: undefined,
                requestedPath: "e2e/login.spec.ts",
                overwriteTarget: undefined,
            }),
        ).toBe(true);
    });
});
