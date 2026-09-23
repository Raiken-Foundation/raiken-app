interface ResultsHeaderProps {
    isExpanded: boolean;
    hasResults: boolean;
    isRunning: boolean;
    passedCount: number;
    failedCount: number;
    timeSeconds: number;
    onToggle: () => void;
}

export function ResultsHeader({
    isExpanded,
    hasResults,
    isRunning,
    passedCount,
    failedCount,
    timeSeconds,
    onToggle,
}: ResultsHeaderProps) {
    return (
        <button type="button" className="results-header" onClick={onToggle}>
            <div className="header-left">
                <svg
                    aria-hidden="true"
                    className={`expand-icon ${isExpanded ? "expanded" : ""}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <path d="M9 5l7 7-7 7" />
                </svg>
                <span className="results-title">Test Results</span>
                {hasResults && !isRunning ? (
                    <div className="header-badges">
                        {passedCount > 0 ? (
                            <span className="badge passed">{passedCount} passed</span>
                        ) : null}
                        {failedCount > 0 ? (
                            <span className="badge failed">{failedCount} failed</span>
                        ) : null}
                    </div>
                ) : null}
                {isRunning ? <span className="badge running">Running...</span> : null}
            </div>
            <div className="header-right">
                {hasResults && timeSeconds > 0 ? (
                    <span className="header-time">{timeSeconds.toFixed(2)}s</span>
                ) : null}
            </div>
        </button>
    );
}
