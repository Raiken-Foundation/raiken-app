import type { TestResult } from "../types";

interface FixTestButtonProps {
    label: string;
    isFixing?: boolean;
    disabled?: boolean;
    onClick: () => void;
}

export function FixTestButton({ label, isFixing, disabled, onClick }: FixTestButtonProps) {
    return (
        <button type="button" className="fix-test-btn" onClick={onClick} disabled={disabled || isFixing}>
            {isFixing ? (
                <>
                    <span className="fix-spinner" />
                    Generating fix…
                </>
            ) : (
                <>
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
                    </svg>
                    {label}
                </>
            )}
        </button>
    );
}

export function InlineAnalyzeButton({
    isInterpreting,
    onClick,
}: {
    isInterpreting?: boolean;
    onClick: () => void;
}) {
    return (
        <button type="button" className="analyze-btn" onClick={onClick} disabled={isInterpreting}>
            {isInterpreting ? (
                <>
                    <div className="btn-spinner" />
                    Analyzing…
                </>
            ) : (
                "Analyze"
            )}
        </button>
    );
}

export function AnalyzeWithAiButton({
    isInterpreting,
    onClick,
}: {
    isInterpreting?: boolean;
    onClick: () => void;
}) {
    return (
        <button type="button" className="analyze-btn" onClick={onClick} disabled={isInterpreting}>
            {isInterpreting ? (
                <>
                    <div className="btn-spinner" />
                    Analyzing...
                </>
            ) : (
                <>
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Analyze with AI
                </>
            )}
        </button>
    );
}

export function FixErrorAlert({ message }: { message: string }) {
    return (
        <div className="fix-error" role="alert">
            {message}
        </div>
    );
}

export function ResultsActionBar({
    failedCount,
    results,
    testCode,
    onRequestFix,
    onAnalyzeClick,
    isFixing,
    isInterpreting,
    fixError,
}: {
    failedCount: number;
    results: TestResult[];
    testCode?: string;
    onRequestFix?: (results: TestResult[]) => void;
    onAnalyzeClick: () => void;
    isFixing?: boolean;
    isInterpreting?: boolean;
    fixError?: string | null;
}) {
    if (failedCount === 0) return null;
    if (!onRequestFix && !testCode) return null;

    return (
        <div className="results-actions">
            <span className="results-actions-label">{failedCount} failing —</span>
            {onRequestFix ? (
                <FixTestButton
                    label="Fix with AI"
                    isFixing={isFixing}
                    onClick={() => onRequestFix(results)}
                />
            ) : null}
            {testCode ? (
                <InlineAnalyzeButton isInterpreting={isInterpreting} onClick={onAnalyzeClick} />
            ) : null}
            {fixError ? <FixErrorAlert message={fixError} /> : null}
        </div>
    );
}
