/**
 * Regression: `raiken search` rendered negative similarity as "-4%
 * playwright.config.ts" — cosine distance ranking can surface
 * anti-correlated chunks when the index is small, and the raw score was
 * mapped straight to a percentage.
 */

import { describe, expect, it } from "vitest";

import { toRelevanceResult } from "../indexing";

describe("toRelevanceResult", () => {
    it("drops anti-correlated (negative similarity) rows", () => {
        expect(toRelevanceResult({ similarity: -0.04 })).toBeNull();
        expect(toRelevanceResult({ similarity: -1 })).toBeNull();
    });

    it("drops zero-similarity (orthogonal) rows", () => {
        expect(toRelevanceResult({ similarity: 0 })).toBeNull();
    });

    it("maps positive similarity to a clamped 0-100 score", () => {
        expect(toRelevanceResult({ similarity: 0.42 })).toEqual({
            similarity: 0.42,
            relevanceScore: 42,
        });
        expect(toRelevanceResult({ similarity: 0.999 })).toEqual({
            similarity: 0.999,
            relevanceScore: 100,
        });
    });

    it("clamps float overshoot above 1", () => {
        expect(toRelevanceResult({ similarity: 1.0000001 })).toEqual({
            similarity: 1,
            relevanceScore: 100,
        });
    });

    it("drops NaN rather than rendering 'NaN%'", () => {
        expect(toRelevanceResult({ similarity: Number.NaN })).toBeNull();
    });
});
