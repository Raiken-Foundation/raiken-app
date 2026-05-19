import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

// Helper function to strip ANSI codes from error messages
function stripAnsiCodes(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\x00-\x1F\x7F]/g, "");
}

export interface TestAttachment {
    name: string;
    contentType: string;
    path?: string;
    body?: string;
}

export interface TestResult {
    id: string;
    name: string;
    suite: string;
    status: "passed" | "failed" | "skipped";
    duration?: number;
    error?: {
        expected?: string;
        received?: string;
        message?: string;
        snippet?: string;
        location?: {
            file: string;
            line: number;
            column: number;
        };
    };
    attachments?: TestAttachment[];
}

export interface TestSummary {
    suites: {
        passed: number;
        failed: number;
        total: number;
    };
    tests: {
        passed: number;
        failed: number;
        total: number;
    };
    time: number;
}

interface TestResultsProps {
    results: TestResult[];
    summary: TestSummary;
    filePath?: string;
    isRunning?: boolean;
    rawOutput?: string;
    /**
     * Snapshot of the test file that was actually run, captured by the
     * parent at run-time. Used only to gate the "Analyze with AI" button
     * (we don't show the analyze button until we have something to send).
     * The parent owns the full request payload — see
     * `handleRequestInterpretation` in `testing-view.tsx` for what
     * additional evidence (rawOutput, attachments, testFilePath) is sent
     * alongside it.
     */
    testCode?: string;
    /**
     * Fired when the user clicks "Analyze with AI". The parent has the
     * full context (snapshotted testCode, rawOutput, attachments) and
     * forwards everything to the interpreter — this component just
     * provides the trigger and the result viewport.
     */
    onRequestInterpretation?: (results: TestResult[]) => void;
    interpretation?: string;
    /**
     * Where the test code in the analysis came from. Surfaced as a small
     * dim banner above the AI output so the user knows whether the
     * diagnosis was grounded in the freshest on-disk file or in a
     * (potentially stale) in-memory snapshot.
     *  - `disk`                     — server read the file at testFilePath
     *  - `client-snapshot`          — no path (e.g. scratch buffer); used the snapshot
     *  - `client-snapshot-fallback` — disk read failed; fell back to the snapshot
     */
    interpretationSource?: "disk" | "client-snapshot" | "client-snapshot-fallback" | null;
    isInterpreting?: boolean;
}

export function TestResults({
    results,
    summary,
    filePath: _filePath,
    isRunning,
    rawOutput,
    testCode,
    onRequestInterpretation,
    interpretation,
    interpretationSource,
    isInterpreting,
}: TestResultsProps) {
    void _filePath; // Reserved for future use
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedTest, setSelectedTest] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"formatted" | "artifacts" | "raw" | "insights">(
        "formatted",
    );

    const failedTests = results.filter((r) => r.status === "failed");
    const passedTests = results.filter((r) => r.status === "passed");
    const hasResults = results.length > 0;

    // Auto-select first failed test and expand when results arrive
    useEffect(() => {
        if (failedTests.length > 0) {
            setSelectedTest(failedTests[0].id);
            setIsExpanded(true);
        }
    }, [results.length]);

    // Switch to insights view when interpretation is available
    const handleAnalyzeClick = () => {
        if (onRequestInterpretation && testCode) {
            onRequestInterpretation(results);
            setViewMode("insights");
        }
    };

    // Get the selected test details
    const selectedTestDetails = selectedTest ? results.find((r) => r.id === selectedTest) : null;

    return (
        <div className={`test-results ${isExpanded ? "expanded" : "collapsed"}`}>
            {/* Header with Summary Badge */}
            <button className="results-header" onClick={() => setIsExpanded(!isExpanded)}>
                <div className="header-left">
                    <svg
                        className={`expand-icon ${isExpanded ? "expanded" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="results-title">Test Results</span>
                    {hasResults && !isRunning && (
                        <div className="header-badges">
                            {passedTests.length > 0 && (
                                <span className="badge passed">{passedTests.length} passed</span>
                            )}
                            {failedTests.length > 0 && (
                                <span className="badge failed">{failedTests.length} failed</span>
                            )}
                        </div>
                    )}
                    {isRunning && <span className="badge running">Running...</span>}
                </div>
                <div className="header-right">
                    {hasResults && summary.time > 0 && (
                        <span className="header-time">{summary.time.toFixed(2)}s</span>
                    )}
                </div>
            </button>

            {isExpanded && (
                <div className="results-content">
                    {/* Running State */}
                    {isRunning && (
                        <div className="running-state">
                            <div className="running-spinner"></div>
                            <span>Running tests...</span>
                            <span className="running-hint">This may take a few moments</span>
                        </div>
                    )}

                    {/* Empty State - Instructions */}
                    {!isRunning && !hasResults && !rawOutput && (
                        <div className="empty-state">
                            <svg
                                className="empty-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M5 3l14 9-14 9V3z" />
                            </svg>
                            <h3>Ready to Run Tests</h3>
                            <p>
                                Select a test file from the editor and click "Run Tests" to execute
                                it.
                            </p>
                            <div className="empty-tips">
                                <h4>Test Execution Tips:</h4>
                                <ul>
                                    <li>Tests run against your application's dev server</li>
                                    <li>
                                        Make sure your dev server is running before executing tests
                                    </li>
                                    <li>Failed tests will show error details and screenshots</li>
                                </ul>
                            </div>
                        </div>
                    )}

                    {/* View Mode Toggle */}
                    {!isRunning && (hasResults || rawOutput) && (
                        <div className="view-toggle">
                            <div className="toggle-group">
                                <button
                                    className={`toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
                                    onClick={() => setViewMode("formatted")}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                    </svg>
                                    Results
                                </button>
                                <button
                                    className={`toggle-btn ${viewMode === "insights" ? "active" : ""}`}
                                    onClick={() => setViewMode("insights")}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                    </svg>
                                    AI Insights
                                </button>
                                <button
                                    className={`toggle-btn ${viewMode === "artifacts" ? "active" : ""}`}
                                    onClick={() => setViewMode("artifacts")}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                    Artifacts
                                </button>
                                <button
                                    className={`toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                                    onClick={() => setViewMode("raw")}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                                    </svg>
                                    Raw
                                </button>
                            </div>
                            {hasResults && testCode && onRequestInterpretation && (
                                <button
                                    className="analyze-btn"
                                    onClick={handleAnalyzeClick}
                                    disabled={isInterpreting}
                                >
                                    {isInterpreting ? (
                                        <>
                                            <div className="btn-spinner"></div>
                                            Analyzing...
                                        </>
                                    ) : (
                                        <>
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                            >
                                                <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                            </svg>
                                            Analyze with AI
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    )}

                    {/* Artifacts View */}
                    {!isRunning && viewMode === "artifacts" && (
                        <div className="artifacts-view">
                            {(() => {
                                // Collect all artifacts from all test results
                                const allArtifacts = results.flatMap((r) =>
                                    (r.attachments || []).map((a) => ({
                                        ...a,
                                        testName: r.name,
                                        testStatus: r.status,
                                    })),
                                );

                                const screenshots = allArtifacts.filter((a) =>
                                    a.contentType?.startsWith("image/"),
                                );
                                const videos = allArtifacts.filter((a) =>
                                    a.contentType?.includes("video"),
                                );
                                const traces = allArtifacts.filter((a) =>
                                    a.name?.includes("trace"),
                                );
                                const other = allArtifacts.filter(
                                    (a) =>
                                        !a.contentType?.startsWith("image/") &&
                                        !a.contentType?.includes("video") &&
                                        !a.name?.includes("trace"),
                                );

                                if (allArtifacts.length === 0) {
                                    return (
                                        <div className="no-artifacts">
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                            >
                                                <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                            </svg>
                                            <h3>No Artifacts Available</h3>
                                            <p>
                                                Run tests with screenshot/video capture enabled to
                                                see artifacts here.
                                            </p>
                                            <div className="artifact-tips">
                                                <h4>Enable in playwright.config.ts:</h4>
                                                <pre>{`use: {
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  trace: 'retain-on-failure',
}`}</pre>
                                            </div>
                                        </div>
                                    );
                                }

                                return (
                                    <div className="artifacts-content">
                                        {/* Screenshots Section */}
                                        {screenshots.length > 0 && (
                                            <div className="artifact-section">
                                                <h4>
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                    >
                                                        <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                    </svg>
                                                    Screenshots ({screenshots.length})
                                                </h4>
                                                <div className="artifact-grid">
                                                    {screenshots.map((s, i) => (
                                                        <div
                                                            key={i}
                                                            className={`artifact-card ${s.testStatus}`}
                                                        >
                                                            <div className="artifact-preview">
                                                                {s.path ? (
                                                                    <img
                                                                        src={`/api/artifact?path=${encodeURIComponent(s.path)}`}
                                                                        alt={s.name}
                                                                    />
                                                                ) : (
                                                                    <div className="placeholder-image">
                                                                        <svg
                                                                            viewBox="0 0 24 24"
                                                                            fill="none"
                                                                            stroke="currentColor"
                                                                            strokeWidth="1.5"
                                                                        >
                                                                            <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                                        </svg>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="artifact-info">
                                                                <span className="artifact-name">
                                                                    {s.name}
                                                                </span>
                                                                <span className="artifact-test">
                                                                    {s.testName}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Videos Section */}
                                        {videos.length > 0 && (
                                            <div className="artifact-section">
                                                <h4>
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                    >
                                                        <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                    </svg>
                                                    Videos ({videos.length})
                                                </h4>
                                                <div className="artifact-list">
                                                    {videos.map((v, i) => (
                                                        <div
                                                            key={i}
                                                            className={`artifact-item video ${v.testStatus}`}
                                                        >
                                                            <svg
                                                                viewBox="0 0 24 24"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                strokeWidth="2"
                                                            >
                                                                <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                            </svg>
                                                            <div className="item-info">
                                                                <span className="item-name">
                                                                    {v.name}
                                                                </span>
                                                                <span className="item-test">
                                                                    {v.testName}
                                                                </span>
                                                            </div>
                                                            {v.path && (
                                                                <a
                                                                    href={`/api/artifact?path=${encodeURIComponent(v.path)}`}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="view-btn"
                                                                >
                                                                    View
                                                                </a>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Traces Section */}
                                        {traces.length > 0 && (
                                            <div className="artifact-section">
                                                <h4>
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                    >
                                                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                                    </svg>
                                                    Traces ({traces.length})
                                                </h4>
                                                <div className="artifact-list">
                                                    {traces.map((t, i) => (
                                                        <div
                                                            key={i}
                                                            className={`artifact-item trace ${t.testStatus}`}
                                                        >
                                                            <svg
                                                                viewBox="0 0 24 24"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                strokeWidth="2"
                                                            >
                                                                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                                                            </svg>
                                                            <div className="item-info">
                                                                <span className="item-name">
                                                                    {t.name}
                                                                </span>
                                                                <span className="item-test">
                                                                    {t.testName}
                                                                </span>
                                                            </div>
                                                            {t.path && (
                                                                <a
                                                                    href={`/api/artifact?path=${encodeURIComponent(t.path)}`}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="view-btn"
                                                                >
                                                                    Open Trace Viewer
                                                                </a>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Other Artifacts */}
                                        {other.length > 0 && (
                                            <div className="artifact-section">
                                                <h4>
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                    >
                                                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    Other Files ({other.length})
                                                </h4>
                                                <div className="artifact-list">
                                                    {other.map((o, i) => (
                                                        <div
                                                            key={i}
                                                            className={`artifact-item other ${o.testStatus}`}
                                                        >
                                                            <svg
                                                                viewBox="0 0 24 24"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                strokeWidth="2"
                                                            >
                                                                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                            </svg>
                                                            <div className="item-info">
                                                                <span className="item-name">
                                                                    {o.name}
                                                                </span>
                                                                <span className="item-test">
                                                                    {o.testName}
                                                                </span>
                                                            </div>
                                                            <span className="item-type">
                                                                {o.contentType}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                    )}

                    {/* Raw Output View */}
                    {!isRunning && viewMode === "raw" && rawOutput && (
                        <div className="raw-output">
                            <pre>{rawOutput}</pre>
                        </div>
                    )}

                    {/* AI Insights View */}
                    {!isRunning && viewMode === "insights" && (
                        <div className="insights-view">
                            {isInterpreting ? (
                                <div className="interpreting-state">
                                    <div className="interpreting-spinner"></div>
                                    <h3>Analyzing Test Results...</h3>
                                    <p>
                                        Reviewing the test code, error messages, raw Playwright
                                        output, and captured artifacts to ground the diagnosis in
                                        evidence.
                                    </p>
                                </div>
                            ) : interpretation ? (
                                <div className="interpretation-content">
                                    <div className="interpretation-header">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                        </svg>
                                        <h3>AI Analysis</h3>
                                    </div>
                                    {/* Provenance hint — tells the user whether
                                        the diagnosis was grounded in the
                                        on-disk file (most accurate) or in our
                                        in-memory snapshot (potentially stale). */}
                                    {interpretationSource === "disk" && (
                                        <p className="interpretation-source disk">
                                            Analysed against the on-disk test file.
                                        </p>
                                    )}
                                    {interpretationSource === "client-snapshot-fallback" && (
                                        <p className="interpretation-source fallback">
                                            ⚠ Could not read the test file from disk. Analysis used
                                            the in-memory snapshot from when the test was run —
                                            diagnosis may be stale if the file has changed since.
                                        </p>
                                    )}
                                    <div className="interpretation-body">
                                        <Markdown
                                            components={{
                                                h1: ({ children }) => (
                                                    <h2 className="int-h2">{children}</h2>
                                                ),
                                                h2: ({ children }) => (
                                                    <h3 className="int-h3">{children}</h3>
                                                ),
                                                h3: ({ children }) => (
                                                    <h4 className="int-h4">{children}</h4>
                                                ),
                                                h4: ({ children }) => (
                                                    <h4 className="int-h4">{children}</h4>
                                                ),
                                                strong: ({ children }) => (
                                                    <strong className="int-bold">{children}</strong>
                                                ),
                                                code: ({ className, children, ...props }) => {
                                                    const isInline = !className;
                                                    return isInline ? (
                                                        <code
                                                            className="int-inline-code"
                                                            {...props}
                                                        >
                                                            {children}
                                                        </code>
                                                    ) : (
                                                        <code
                                                            className={`int-code-block ${className || ""}`}
                                                            {...props}
                                                        >
                                                            {children}
                                                        </code>
                                                    );
                                                },
                                                pre: ({ children }) => {
                                                    const preRef = useRef<HTMLPreElement>(null);
                                                    return (
                                                        <pre ref={preRef} className="int-pre">
                                                            {children}
                                                        </pre>
                                                    );
                                                },
                                                a: ({ href, children }) => (
                                                    <a
                                                        href={href}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="int-link"
                                                    >
                                                        {children}
                                                    </a>
                                                ),
                                                ul: ({ children }) => (
                                                    <ul className="int-list">{children}</ul>
                                                ),
                                                ol: ({ children }) => (
                                                    <ol className="int-list int-list-ordered">
                                                        {children}
                                                    </ol>
                                                ),
                                                blockquote: ({ children }) => (
                                                    <blockquote className="int-blockquote">
                                                        {children}
                                                    </blockquote>
                                                ),
                                                table: ({ children }) => (
                                                    <div className="int-table-wrap">
                                                        <table className="int-table">
                                                            {children}
                                                        </table>
                                                    </div>
                                                ),
                                                th: ({ children }) => (
                                                    <th className="int-th">{children}</th>
                                                ),
                                                td: ({ children }) => (
                                                    <td className="int-td">{children}</td>
                                                ),
                                            }}
                                        >
                                            {interpretation}
                                        </Markdown>
                                    </div>
                                </div>
                            ) : (
                                <div className="no-insights">
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                    >
                                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                    </svg>
                                    <h3>No Analysis Yet</h3>
                                    <p>
                                        Click "Analyze with AI" to get intelligent insights about
                                        your test results.
                                    </p>
                                    {testCode && onRequestInterpretation && (
                                        <button
                                            className="start-analysis-btn"
                                            onClick={handleAnalyzeClick}
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                            >
                                                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                                            </svg>
                                            Start Analysis
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Formatted Results View */}
                    {!isRunning && viewMode === "formatted" && hasResults && (
                        <div className="formatted-results">
                            {/* Test List */}
                            <div className="test-list">
                                {results.map((result) => (
                                    <button
                                        key={result.id}
                                        className={`test-item ${result.status} ${selectedTest === result.id ? "selected" : ""}`}
                                        onClick={() =>
                                            setSelectedTest(
                                                selectedTest === result.id ? null : result.id,
                                            )
                                        }
                                    >
                                        <span className="status-icon">
                                            {result.status === "passed" && (
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <path d="M5 13l4 4L19 7" />
                                                </svg>
                                            )}
                                            {result.status === "failed" && (
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <path d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            )}
                                            {result.status === "skipped" && (
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <circle cx="12" cy="12" r="10" />
                                                </svg>
                                            )}
                                        </span>
                                        <div className="test-info">
                                            <span className="test-name">{result.name}</span>
                                            <span className="test-suite">{result.suite}</span>
                                        </div>
                                        {result.duration && (
                                            <span className="test-duration">
                                                {result.duration}ms
                                            </span>
                                        )}
                                        <svg
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

                            {/* Selected Test Details */}
                            {selectedTestDetails && (
                                <div className="test-details">
                                    <div className="details-header">
                                        <span
                                            className={`status-badge ${selectedTestDetails.status}`}
                                        >
                                            {selectedTestDetails.status.toUpperCase()}
                                        </span>
                                        <h3>{selectedTestDetails.name}</h3>
                                        {selectedTestDetails.duration && (
                                            <span className="duration">
                                                {selectedTestDetails.duration}ms
                                            </span>
                                        )}
                                    </div>

                                    {/* Error Details */}
                                    {selectedTestDetails.error && (
                                        <div className="error-section">
                                            <h4>Error Details</h4>
                                            {selectedTestDetails.error.message && (
                                                <div className="error-message">
                                                    {stripAnsiCodes(
                                                        selectedTestDetails.error.message,
                                                    )}
                                                </div>
                                            )}
                                            {selectedTestDetails.error.snippet && (
                                                <pre className="error-snippet">
                                                    {selectedTestDetails.error.snippet}
                                                </pre>
                                            )}
                                            {selectedTestDetails.error.location && (
                                                <div className="error-location">
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                    >
                                                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    <span>
                                                        {selectedTestDetails.error.location.file
                                                            .split("/")
                                                            .pop()}
                                                        :{selectedTestDetails.error.location.line}:
                                                        {selectedTestDetails.error.location.column}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Artifacts intentionally not duplicated here.
                                        The dedicated "Artifacts" tab is the single
                                        source of truth for screenshots/videos/traces;
                                        listing them per-test in the Results tab was
                                        noise. The data still flows through to the
                                        AI insights flow via `attachments`. */}

                                    {/* Success message for passed tests */}
                                    {selectedTestDetails.status === "passed" && (
                                        <div className="success-message">
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                            >
                                                <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span>
                                                Test passed successfully in{" "}
                                                {selectedTestDetails.duration}ms
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Summary Bar */}
                            <div className="summary-bar">
                                <div className="summary-stats">
                                    <span className="stat">
                                        <strong>{summary.tests.total}</strong> tests
                                    </span>
                                    <span className="stat passed">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="M5 13l4 4L19 7" />
                                        </svg>
                                        {summary.tests.passed} passed
                                    </span>
                                    {summary.tests.failed > 0 && (
                                        <span className="stat failed">
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                            >
                                                <path d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                            {summary.tests.failed} failed
                                        </span>
                                    )}
                                </div>
                                <span className="summary-time">
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    {summary.time.toFixed(2)}s
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <style>{`
        .test-results {
          display: flex;
          flex-direction: column;
          width: 100%;
          background: var(--bg);
          border-top: 1px solid var(--hair);
          font-family: var(--mono);
          color: var(--ink);
          overflow: hidden;
          box-sizing: border-box;
          flex-shrink: 0;
        }
        .test-results.expanded {
          max-height: 50vh;
          min-height: 260px;
        }
        .test-results.collapsed {
          max-height: none;
          min-height: 0;
        }

        .results-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0.75rem;
          height: 28px;
          background: var(--bg-bar);
          border: 0;
          cursor: pointer;
          width: 100%;
          font-family: var(--mono);
          font-size: 11px;
          color: var(--ink-dim);
        }
        .test-results.expanded .results-header {
          border-bottom: 1px solid var(--hair);
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .header-right {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .header-time {
          color: var(--ink-faint);
          font-family: var(--mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .expand-icon {
          width: 10px;
          height: 10px;
          color: var(--ink-faint);
          transition: transform 0.15s;
        }
        .expand-icon.expanded { transform: rotate(90deg); }
        .results-title {
          color: var(--accent);
          font-family: var(--mono);
          font-size: 11px;
        }
        .results-title::before {
          content: "● ";
          color: var(--accent);
        }
        .header-badges {
          display: flex;
          gap: 0.4375rem;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          padding: 1px 5px;
          font-family: var(--mono);
          font-size: 10.5px;
          font-weight: 500;
          letter-spacing: 0.02em;
          border: 1px solid var(--hair);
          background: var(--bg);
        }
        .badge.passed { color: var(--pass); border-color: rgba(111, 184, 111, 0.3); background: var(--pass-soft); }
        .badge.failed { color: var(--fail); border-color: rgba(215, 92, 92, 0.3); background: var(--fail-soft); }
        .badge.running { color: var(--info); border-color: rgba(111, 163, 198, 0.3); background: var(--info-soft); }

        .results-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }

        .running-state,
        .empty-state,
        .no-artifacts,
        .no-insights,
        .interpreting-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 2rem 1rem;
          text-align: center;
          font-family: var(--mono);
          color: var(--ink-dim);
          overflow-y: auto;
        }
        .running-state .running-spinner,
        .interpreting-state .interpreting-spinner {
          width: 18px;
          height: 18px;
          border: 2px solid var(--hair-strong);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: q-spin 0.8s linear infinite;
        }
        .running-hint {
          color: var(--ink-faint);
          font-size: 11px;
        }
        .empty-icon,
        .no-artifacts svg,
        .no-insights svg {
          width: 24px;
          height: 24px;
          color: var(--ink-mute);
          margin-bottom: 0.25rem;
        }
        .empty-state h3,
        .no-artifacts h3,
        .no-insights h3,
        .interpreting-state h3 {
          margin: 0;
          font-family: var(--mono);
          font-size: 13px;
          font-weight: 500;
          color: var(--ink);
        }
        .empty-state h3::before,
        .no-artifacts h3::before,
        .no-insights h3::before,
        .interpreting-state h3::before {
          content: "# ";
          color: var(--accent);
          font-weight: 400;
        }
        .empty-state p,
        .no-artifacts p,
        .no-insights p,
        .interpreting-state p {
          margin: 0;
          font-size: 12px;
          color: var(--ink-dim);
          max-width: 50ch;
          line-height: 1.55;
        }
        .empty-tips,
        .artifact-tips {
          margin-top: 0.75rem;
          padding: 0.625rem 0.75rem;
          background: var(--bg-bar);
          border: 1px solid var(--hair);
          text-align: left;
          max-width: 60ch;
          font-size: 11.5px;
        }
        .empty-tips h4,
        .artifact-tips h4 {
          margin: 0 0 0.375rem;
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .empty-tips ul { margin: 0; padding-left: 1rem; color: var(--ink-dim); line-height: 1.6; }
        .artifact-tips pre {
          margin: 0;
          color: var(--ink);
          font-family: var(--mono);
          font-size: 11px;
          white-space: pre;
          overflow-x: auto;
        }

        .view-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          padding: 0.25rem 0.5rem;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair);
          flex-shrink: 0;
        }
        .toggle-group {
          display: flex;
          gap: 0;
        }
        .toggle-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.3125rem 0.625rem;
          background: transparent;
          border: 0;
          color: var(--ink-faint);
          font-family: var(--mono);
          font-size: 11px;
          cursor: pointer;
          transition: color 0.12s, background 0.12s;
          position: relative;
        }
        .toggle-btn:hover { color: var(--ink-dim); background: var(--hair-soft); }
        .toggle-btn.active {
          color: var(--ink);
          background: var(--bg);
        }
        .toggle-btn.active::before {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 1px;
          background: var(--accent);
        }
        .toggle-btn svg { width: 11px; height: 11px; }

        .analyze-btn,
        .start-analysis-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.3125rem 0.625rem;
          background: transparent;
          border: 1px solid var(--accent-dim);
          color: var(--accent);
          font-family: var(--mono);
          font-size: 11px;
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s;
        }
        .analyze-btn:hover:not(:disabled),
        .start-analysis-btn:hover:not(:disabled) {
          background: var(--accent-dim);
          border-color: var(--accent);
        }
        .analyze-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .analyze-btn svg,
        .start-analysis-btn svg { width: 11px; height: 11px; }
        .btn-spinner {
          width: 10px;
          height: 10px;
          border: 1.5px solid var(--ink-faint);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: q-spin 0.7s linear infinite;
        }

        /* ------- Formatted results ------- */
        .formatted-results {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }
        .test-list {
          flex: 1;
          overflow-y: auto;
          border-bottom: 1px solid var(--hair);
        }
        .test-item {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          width: 100%;
          padding: 0.375rem 0.75rem;
          background: transparent;
          border: 0;
          border-bottom: 1px solid var(--hair-soft);
          color: var(--ink);
          font-family: var(--mono);
          font-size: 12px;
          cursor: pointer;
          text-align: left;
          transition: background 0.1s;
        }
        .test-item:hover { background: var(--bg-hover); }
        .test-item.selected { background: var(--accent-soft); }
        .test-item .status-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          flex-shrink: 0;
        }
        .test-item .status-icon svg { width: 11px; height: 11px; }
        .test-item.passed .status-icon { color: var(--pass); }
        .test-item.failed .status-icon { color: var(--fail); }
        .test-item.skipped .status-icon { color: var(--ink-faint); }
        .test-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .test-name { color: var(--ink); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .test-suite { color: var(--ink-faint); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .test-duration {
          color: var(--ink-faint);
          font-size: 10.5px;
          font-variant-numeric: tabular-nums;
          flex-shrink: 0;
        }
        .test-item .chevron {
          width: 10px;
          height: 10px;
          color: var(--ink-faint);
          flex-shrink: 0;
        }

        .test-details {
          padding: 0.75rem 0.875rem;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair);
        }
        .details-header {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          margin-bottom: 0.5rem;
        }
        .details-header h3 {
          margin: 0;
          font-family: var(--mono);
          font-size: 12.5px;
          font-weight: 500;
          color: var(--ink);
          flex: 1;
        }
        .details-header .duration {
          color: var(--ink-faint);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .status-badge {
          font-family: var(--mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 1px 5px;
        }
        .status-badge.passed { color: var(--pass); background: var(--pass-soft); }
        .status-badge.failed { color: var(--fail); background: var(--fail-soft); }
        .status-badge.skipped { color: var(--ink-faint); background: var(--bg); }

        .error-section {
          margin-top: 0.625rem;
        }
        .error-section h4 {
          margin: 0 0 0.375rem;
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .error-message {
          padding: 0.5rem 0.625rem;
          background: var(--fail-soft);
          border-left: 1px solid var(--fail);
          color: var(--ink);
          font-family: var(--mono);
          font-size: 11.5px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .error-snippet {
          margin: 0.375rem 0 0;
          padding: 0.4375rem 0.625rem;
          background: var(--bg);
          border: 1px solid var(--hair);
          color: var(--ink-dim);
          font-family: var(--mono);
          font-size: 11px;
          line-height: 1.6;
          white-space: pre;
          overflow-x: auto;
        }
        .error-location {
          margin-top: 0.375rem;
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: var(--ink-faint);
          font-family: var(--mono);
          font-size: 11px;
        }
        .error-location svg { width: 11px; height: 11px; }

        .artifact-item {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          padding: 0.3125rem 0.5rem;
          background: var(--bg);
          border: 1px solid var(--hair);
          font-family: var(--mono);
          font-size: 11.5px;
          color: var(--ink);
        }
        .artifact-item svg {
          width: 12px;
          height: 12px;
          color: var(--ink-faint);
          flex-shrink: 0;
        }
        .item-name { color: var(--ink); }
        .item-type {
          margin-left: auto;
          color: var(--ink-faint);
          font-size: 10.5px;
        }
        .item-info {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
        }
        .item-test {
          color: var(--ink-faint);
          font-size: 10.5px;
        }
        .view-btn {
          padding: 2px 6px;
          background: transparent;
          border: 1px solid var(--hair-strong);
          color: var(--ink-dim);
          font-family: var(--mono);
          font-size: 10.5px;
          text-decoration: none;
          cursor: pointer;
        }
        .view-btn:hover {
          background: var(--bg-hover);
          color: var(--accent);
          border-color: var(--accent-dim);
        }

        .success-message {
          margin-top: 0.625rem;
          display: inline-flex;
          align-items: center;
          gap: 0.4375rem;
          padding: 0.375rem 0.5rem;
          background: var(--pass-soft);
          border: 1px solid rgba(111, 184, 111, 0.3);
          color: var(--pass);
          font-family: var(--mono);
          font-size: 11.5px;
        }
        .success-message svg { width: 12px; height: 12px; }

        .summary-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.375rem 0.75rem;
          background: var(--bg-bar);
          border-top: 1px solid var(--hair);
          font-family: var(--mono);
          font-size: 11px;
          flex-shrink: 0;
        }
        .summary-stats {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .summary-stats .stat {
          display: inline-flex;
          align-items: baseline;
          gap: 0.375rem;
          color: var(--ink-faint);
          font-variant-numeric: tabular-nums;
        }
        .summary-stats .stat svg { width: 10px; height: 10px; align-self: center; }
        .summary-stats .stat strong { color: var(--ink); font-weight: 500; }
        .summary-stats .stat.passed { color: var(--pass); }
        .summary-stats .stat.failed { color: var(--fail); }
        .summary-time {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: var(--ink-faint);
          font-variant-numeric: tabular-nums;
        }
        .summary-time svg { width: 10px; height: 10px; }

        /* ------- Raw output ------- */
        .raw-output {
          flex: 1;
          overflow: auto;
          background: var(--bg-sunken);
          border-bottom: 1px solid var(--hair);
        }
        .raw-output pre {
          margin: 0;
          padding: 0.75rem 0.875rem;
          font-family: var(--mono);
          font-size: 11.5px;
          color: var(--ink);
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* ------- Artifacts view ------- */
        .artifacts-view {
          flex: 1;
          overflow-y: auto;
          padding: 0.75rem 0.875rem;
        }
        .artifacts-content {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .artifact-section h4 {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          margin: 0 0 0.4375rem;
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .artifact-section h4 svg { width: 11px; height: 11px; }

        .artifact-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 0.5rem;
        }
        .artifact-card {
          background: var(--bg-bar);
          border: 1px solid var(--hair);
          overflow: hidden;
        }
        .artifact-card.failed { border-left: 1px solid var(--fail); }
        .artifact-card.passed { border-left: 1px solid var(--pass); }
        .artifact-preview {
          aspect-ratio: 16 / 10;
          background: var(--bg);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .artifact-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .placeholder-image {
          color: var(--ink-mute);
        }
        .placeholder-image svg {
          width: 24px;
          height: 24px;
        }
        .artifact-info {
          padding: 0.375rem 0.5rem;
          display: flex;
          flex-direction: column;
          font-family: var(--mono);
          font-size: 11px;
        }
        .artifact-name { color: var(--ink); }
        .artifact-test { color: var(--ink-faint); font-size: 10.5px; }

        .artifact-list {
          display: flex;
          flex-direction: column;
          gap: 0.1875rem;
        }
        .artifact-item.failed { border-left: 1px solid var(--fail); }
        .artifact-item.passed { border-left: 1px solid var(--pass); }

        /* ------- AI Insights / interpretation ------- */
        .insights-view {
          flex: 1;
          overflow-y: auto;
          padding: 0.875rem 1rem;
        }
        .interpretation-content { max-width: 820px; margin: 0 auto; }
        .interpretation-header {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          margin-bottom: 0.75rem;
          padding-bottom: 0.4375rem;
          border-bottom: 1px solid var(--hair);
        }
        .interpretation-header svg { width: 13px; height: 13px; color: var(--accent); }
        .interpretation-header h3 {
          margin: 0;
          font-family: var(--mono);
          font-size: 12.5px;
          font-weight: 500;
          color: var(--ink);
        }
        .interpretation-header h3::before {
          content: "# ";
          color: var(--accent);
          font-weight: 400;
        }
        .interpretation-source {
          font-family: var(--mono);
          font-size: 11px;
          margin: 0 0 0.625rem;
          padding: 0.375rem 0.5rem;
          border-radius: 3px;
          line-height: 1.4;
        }
        .interpretation-source.disk {
          color: var(--ink-dim);
          background: transparent;
        }
        .interpretation-source.fallback {
          color: var(--ink);
          background: rgba(255, 184, 0, 0.08);
          border-left: 2px solid var(--warn, #ffb800);
          padding-left: 0.5rem;
        }
        .interpretation-body {
          color: var(--ink);
          font-family: var(--mono);
          font-size: 12.5px;
          line-height: 1.6;
        }
        .interpretation-body p { margin: 0 0 0.625rem; }
        .int-h2, .int-h3, .int-h4 {
          margin: 1rem 0 0.375rem;
          font-family: var(--mono);
          font-weight: 500;
          color: var(--ink);
        }
        .int-h2::before, .int-h3::before, .int-h4::before {
          content: "# ";
          color: var(--accent);
          font-weight: 400;
        }
        .int-h2 { font-size: 14px; }
        .int-h3 { font-size: 13px; }
        .int-h4 { font-size: 12.5px; }
        .int-bold { color: var(--ink); font-weight: 600; }
        .int-inline-code {
          padding: 0 4px;
          background: var(--bg);
          border: 1px solid var(--hair);
          color: var(--accent);
          font-family: var(--mono);
          font-size: 11.5px;
        }
        .int-pre {
          margin: 0.5rem 0;
          padding: 0.625rem 0.75rem;
          background: var(--bg-sunken);
          border: 1px solid var(--hair);
          overflow-x: auto;
          font-family: var(--mono);
          font-size: 11.5px;
          color: var(--ink);
          line-height: 1.6;
        }
        .int-code-block {
          font-family: var(--mono);
          color: var(--ink);
        }
        .int-link { color: var(--accent); text-decoration: none; }
        .int-link:hover { text-decoration: underline; }
        .int-list {
          margin: 0.375rem 0;
          padding-left: 1.125rem;
          color: var(--ink);
        }
        .int-list-ordered { list-style-type: decimal; }
        .int-list li { margin: 0.125rem 0; }
        .int-blockquote {
          margin: 0.5rem 0;
          padding: 0.125rem 0.75rem;
          border-left: 1px solid var(--accent);
          background: var(--bg-bar);
          color: var(--ink-dim);
        }
        .int-table-wrap {
          margin: 0.5rem 0;
          overflow-x: auto;
          border: 1px solid var(--hair);
        }
        .int-table {
          width: 100%;
          border-collapse: collapse;
          font-family: var(--mono);
          font-size: 11.5px;
        }
        .int-th, .int-td {
          padding: 0.3125rem 0.5rem;
          border-bottom: 1px solid var(--hair);
          text-align: left;
        }
        .int-th {
          background: var(--bg-bar);
          color: var(--ink-faint);
          font-weight: 500;
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
      `}</style>
        </div>
    );
}
