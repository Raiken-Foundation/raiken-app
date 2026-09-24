import type { TestResult } from "../types";
import { outcomeLabel, statusBucket, stripAnsiCodes } from "../model/report-model";

export function FailureDetails({ error }: { error: NonNullable<TestResult["error"]> }) {
    return (
        <div className="error-section">
            <h4>Error Details</h4>
            {error.message ? (
                <div className="error-message">{stripAnsiCodes(error.message)}</div>
            ) : null}
            {error.snippet ? <pre className="error-snippet">{error.snippet}</pre> : null}
            {error.location ? (
                <div className="error-location">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span>
                        {error.location.file.split("/").pop()}:{error.location.line}:
                        {error.location.column}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

export function TestDetailsPanel({ test }: { test: TestResult }) {
    return (
        <div className="test-details">
            <div className="details-header">
                <span className={`status-badge ${statusBucket(test.status)}`}>
                    {outcomeLabel(test.status)}
                </span>
                <h3>{test.name}</h3>
                {test.duration ? <span className="duration">{test.duration}ms</span> : null}
            </div>

            {test.error ? <FailureDetails error={test.error} /> : null}

            {test.status === "passed" ? (
                <div className="success-message">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>Test passed successfully in {test.duration}ms</span>
                </div>
            ) : null}
        </div>
    );
}
