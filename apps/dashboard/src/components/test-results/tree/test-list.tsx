import type { KeyboardEvent } from "react";
import type { TestResult } from "../types";
import { statusBucket } from "../model/report-model";
import { TestStatusIcon } from "./test-status-icon";

interface TestListProps {
    results: TestResult[];
    selectedTest: string | null;
    onSelectTest: (testId: string | null) => void;
}

export function TestList({ results, selectedTest, onSelectTest }: TestListProps) {
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, result: TestResult) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectTest(selectedTest === result.id ? null : result.id);
        }
    };

    return (
        <div className="test-list" role="list">
            {results.map((result) => (
                <button
                    type="button"
                    key={result.id}
                    role="listitem"
                    className={`test-item ${statusBucket(result.status)} ${selectedTest === result.id ? "selected" : ""}`}
                    onClick={() => onSelectTest(selectedTest === result.id ? null : result.id)}
                    onKeyDown={(event) => handleKeyDown(event, result)}
                    aria-expanded={selectedTest === result.id}
                >
                    <span className="status-icon">
                        <TestStatusIcon status={result.status} />
                    </span>
                    <div className="test-info">
                        <span className="test-name">{result.name}</span>
                        <span className="test-suite">{result.suite}</span>
                    </div>
                    {result.duration ? (
                        <span className="test-duration">{result.duration}ms</span>
                    ) : null}
                    <svg
                        aria-hidden="true"
                        className="chevron"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M9 5l7 7-7 7" />
                    </svg>
                </button>
            ))}
        </div>
    );
}
