import { describe, expect, it } from "vitest";
import { raikenConfigSchema, validateConfig } from "../config/schema";

describe("raikenConfigSchema", () => {
    it("accepts an empty config (all fields optional)", () => {
        expect(() => validateConfig({})).not.toThrow();
    });

    it("accepts a well-formed partial config", () => {
        const result = raikenConfigSchema.safeParse({
            ai: { provider: "anthropic", temperature: 0.5 },
            discovery: { maxPages: 20, preserveQueryParams: true },
        });
        expect(result.success).toBe(true);
    });

    it("rejects an out-of-range temperature", () => {
        const result = raikenConfigSchema.safeParse({ ai: { temperature: 5 } });
        expect(result.success).toBe(false);
    });

    it("rejects an unknown AI provider", () => {
        const result = raikenConfigSchema.safeParse({ ai: { provider: "not-a-provider" } });
        expect(result.success).toBe(false);
    });

    it("rejects a non-boolean preserveQueryParams", () => {
        const result = raikenConfigSchema.safeParse({
            discovery: { preserveQueryParams: "yes" },
        });
        expect(result.success).toBe(false);
    });

    it("rejects a non-positive maxPages", () => {
        const result = raikenConfigSchema.safeParse({ discovery: { maxPages: 0 } });
        expect(result.success).toBe(false);
    });
});
