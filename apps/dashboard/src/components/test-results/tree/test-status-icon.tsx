import type { PlaywrightOutcomeStatus, TestResult } from "../types";
import { toDisplayOutcome } from "../model/report-model";

export function TestStatusIcon({
    status,
    detail,
}: {
    status: TestResult["status"];
    detail?: PlaywrightOutcomeStatus;
}) {
    const display = toDisplayOutcome(status, detail);
    if (display === "passed") {
        return (
            <svg role="img" aria-label="Passed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 13l4 4L19 7" />
            </svg>
        );
    }
    if (display === "skipped") {
        return (
            <svg role="img" aria-label="Skipped" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
            </svg>
        );
    }
    if (display === "flaky") {
        return (
            <svg role="img" aria-label="Flaky" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
            </svg>
        );
    }
    if (display === "timeout") {
        return (
            <svg role="img" aria-label="Timed out" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
        );
    }
    return (
        <svg role="img" aria-label="Failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 18L18 6M6 6l12 12" />
        </svg>
    );
}
