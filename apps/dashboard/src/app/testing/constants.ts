import type { TestResult, TestSummary } from "./types";

export const emptyTestResults: TestResult[] = [];

export const emptySummary: TestSummary = {
    suites: { passed: 0, failed: 0, total: 0 },
    tests: { passed: 0, failed: 0, total: 0 },
    time: 0,
};
