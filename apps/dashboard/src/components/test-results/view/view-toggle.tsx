import type { TestResultsViewMode } from "../types";
import { AnalyzeWithAiButton } from "../analysis/repair-actions";

interface ViewToggleProps {
    viewMode: TestResultsViewMode;
    onViewModeChange: (mode: TestResultsViewMode) => void;
    hasResults: boolean;
    rawOutput?: string;
    testCode?: string;
    onExportReport?: (formats: Array<"html" | "markdown" | "json">) => void;
    canExportReport?: boolean;
    isExporting?: boolean;
    exportMarkdown: boolean;
    onExportMarkdownChange: (checked: boolean) => void;
    onRequestInterpretation?: () => void;
    isInterpreting?: boolean;
}

export function ViewToggle({
    viewMode,
    onViewModeChange,
    hasResults,
    rawOutput,
    testCode,
    onExportReport,
    canExportReport = true,
    isExporting,
    exportMarkdown,
    onExportMarkdownChange,
    onRequestInterpretation,
    isInterpreting,
}: ViewToggleProps) {
    if (!hasResults && !rawOutput) return null;

    return (
        <div className="view-toggle">
            <div className="toggle-group" role="tablist" aria-label="Test result views">
                <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "formatted"}
                    className={`toggle-btn ${viewMode === "formatted" ? "active" : ""}`}
                    onClick={() => onViewModeChange("formatted")}
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    Results
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "insights"}
                    className={`toggle-btn ${viewMode === "insights" ? "active" : ""}`}
                    onClick={() => onViewModeChange("insights")}
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    AI Insights
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "artifacts"}
                    className={`toggle-btn ${viewMode === "artifacts" ? "active" : ""}`}
                    onClick={() => onViewModeChange("artifacts")}
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Artifacts
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "raw"}
                    className={`toggle-btn ${viewMode === "raw" ? "active" : ""}`}
                    onClick={() => onViewModeChange("raw")}
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    Raw
                </button>
            </div>
            {hasResults && onExportReport ? (
                <>
                    <button
                        type="button"
                        className="analyze-btn"
                        onClick={() =>
                            onExportReport(
                                exportMarkdown ? ["html", "markdown", "json"] : ["html", "json"],
                            )
                        }
                        disabled={isExporting || !canExportReport}
                        title={
                            canExportReport
                                ? "Write a detailed HTML report with screenshots"
                                : "No structured report available for this run"
                        }
                    >
                        {isExporting ? (
                            <>
                                <div className="btn-spinner" />
                                Exporting...
                            </>
                        ) : (
                            <>
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                                </svg>
                                Export report
                            </>
                        )}
                    </button>
                    {canExportReport ? (
                        <label
                            className="export-md-toggle"
                            title="Also write a Markdown copy of the report"
                        >
                            <input
                                type="checkbox"
                                checked={exportMarkdown}
                                onChange={(event) => onExportMarkdownChange(event.target.checked)}
                                disabled={isExporting}
                            />
                            + Markdown
                        </label>
                    ) : null}
                </>
            ) : null}
            {hasResults && testCode && onRequestInterpretation ? (
                <AnalyzeWithAiButton isInterpreting={isInterpreting} onClick={onRequestInterpretation} />
            ) : null}
        </div>
    );
}
