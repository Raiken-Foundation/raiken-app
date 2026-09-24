import Markdown from "react-markdown";
import type { TestResult, TestResultsProps } from "../types";
import { interpretationMarkdownComponents } from "./markdown-components";
import { AnalyzeWithAiButton, FixErrorAlert, FixTestButton } from "./repair-actions";

interface InsightsViewProps {
    isInterpreting?: boolean;
    interpretation?: string;
    interpretationSource?: TestResultsProps["interpretationSource"];
    failedCount: number;
    testCode?: string;
    onRequestInterpretation?: (results: TestResult[]) => void;
    onRequestFix?: (results: TestResult[]) => void;
    onAnalyzeClick: () => void;
    onFixClick: () => void;
    isFixing?: boolean;
    fixError?: string | null;
    results: TestResult[];
}

export function InsightsView({
    isInterpreting,
    interpretation,
    interpretationSource,
    failedCount,
    testCode,
    onRequestInterpretation,
    onRequestFix,
    onAnalyzeClick,
    onFixClick,
    isFixing,
    fixError,
}: InsightsViewProps) {
    return (
        <div className="insights-view">
            {isInterpreting ? (
                <div className="interpreting-state">
                    <div className="interpreting-spinner" />
                    <h3>Analyzing Test Results...</h3>
                    <p>
                        Reviewing the test code, error messages, raw Playwright output, and captured
                        artifacts to ground the diagnosis in evidence.
                    </p>
                </div>
            ) : interpretation ? (
                <div className="interpretation-content">
                    <div className="interpretation-header">
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        <h3>AI Analysis</h3>
                    </div>
                    {interpretationSource === "disk" ? (
                        <p className="interpretation-source disk">Analysed against the on-disk test file.</p>
                    ) : null}
                    {interpretationSource === "client-snapshot-fallback" ? (
                        <p className="interpretation-source fallback">
                            ⚠ Could not read the test file from disk. Analysis used the in-memory snapshot
                            from when the test was run — diagnosis may be stale if the file has changed since.
                        </p>
                    ) : null}
                    <div className="interpretation-body">
                        <Markdown components={interpretationMarkdownComponents}>{interpretation}</Markdown>
                    </div>
                    {onRequestFix && failedCount > 0 ? (
                        <div className="interpretation-actions">
                            <FixTestButton
                                label="Fix test — update the spec"
                                isFixing={isFixing}
                                onClick={onFixClick}
                            />
                            <span className="fix-test-hint">
                                Opens a corrected spec in the editor to review, run, and save.
                            </span>
                            {fixError ? <FixErrorAlert message={fixError} /> : null}
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="no-insights">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <h3>No Analysis Yet</h3>
                    <p>Click "Analyze with AI" for intelligent insights, or fix the failing test directly.</p>
                    <div className="no-insights-actions">
                        {testCode && onRequestInterpretation ? (
                            <button type="button" className="start-analysis-btn" onClick={onAnalyzeClick}>
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                Start Analysis
                            </button>
                        ) : null}
                        {onRequestFix && failedCount > 0 ? (
                            <FixTestButton
                                label="Fix test — update the spec"
                                isFixing={isFixing}
                                onClick={onFixClick}
                            />
                        ) : null}
                    </div>
                    {fixError ? <FixErrorAlert message={fixError} /> : null}
                </div>
            )}
        </div>
    );
}
