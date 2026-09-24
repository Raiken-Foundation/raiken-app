import type { TestSummary } from "../types";

export function SummaryBar({ summary }: { summary: TestSummary }) {
    return (
        <div className="summary-bar">
            <div className="summary-stats">
                <span className="stat">
                    <strong>{summary.tests.total}</strong> tests
                </span>
                <span className="stat passed">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 13l4 4L19 7" />
                    </svg>
                    {summary.tests.passed} passed
                </span>
                {summary.tests.failed > 0 ? (
                    <span className="stat failed">
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        {summary.tests.failed} failed
                    </span>
                ) : null}
            </div>
            <span className="summary-time">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {summary.time.toFixed(2)}s
            </span>
        </div>
    );
}
