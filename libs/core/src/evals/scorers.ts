/**
 * Scorer helpers. Scenario-specific expectations live with their scenarios;
 * these are the generic building blocks.
 */

import type { EvalScore, EvalScorer } from "./types";

/** Wrap a predicate-with-detail function as a named scorer. */
export function scorer<T>(
    name: string,
    fn: (output: T) => Omit<EvalScore, "name"> | boolean,
): EvalScorer<T> {
    return {
        name,
        score: (output: T): EvalScore => {
            const result = fn(output);
            if (typeof result === "boolean") return { name, passed: result };
            return { name, ...result };
        },
    };
}

/** Score a count against a minimum, reporting the observed value. */
export function atLeast<T>(
    name: string,
    minimum: number,
    count: (output: T) => number,
): EvalScorer<T> {
    return scorer(name, (output) => {
        const value = count(output);
        return {
            passed: value >= minimum,
            value,
            detail: `expected ≥ ${minimum}, got ${value}`,
        };
    });
}
