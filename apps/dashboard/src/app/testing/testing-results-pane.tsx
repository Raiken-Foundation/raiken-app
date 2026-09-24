import { type TestResult, TestResults, type TestSummary } from "../../components/test-results";
import type { InterpretationSource } from "./types";

interface TestingResultsPaneProps {
    results: TestResult[];
    summary: TestSummary;
    filePath?: string;
    isRunning: boolean;
    rawOutput: string;
    testCode: string;
    onRequestInterpretation: (results: TestResult[]) => void;
    interpretation: string;
    interpretationSource: InterpretationSource;
    isInterpreting: boolean;
    onRequestFix: (results: TestResult[]) => void;
    isFixing: boolean;
    fixError: string | null;
    onExportReport: (formats?: Array<"html" | "markdown" | "json">) => void;
    canExportReport: boolean;
    isExporting: boolean;
    exportedReportPath: string | null;
}

export function TestingResultsPane({
    results,
    summary,
    filePath,
    isRunning,
    rawOutput,
    testCode,
    onRequestInterpretation,
    interpretation,
    interpretationSource,
    isInterpreting,
    onRequestFix,
    isFixing,
    fixError,
    onExportReport,
    canExportReport,
    isExporting,
    exportedReportPath,
}: TestingResultsPaneProps) {
    return (
        <TestResults
            results={results}
            summary={summary}
            filePath={filePath}
            isRunning={isRunning}
            rawOutput={rawOutput}
            testCode={testCode}
            onRequestInterpretation={onRequestInterpretation}
            interpretation={interpretation}
            interpretationSource={interpretationSource}
            isInterpreting={isInterpreting}
            onRequestFix={onRequestFix}
            isFixing={isFixing}
            fixError={fixError}
            onExportReport={onExportReport}
            canExportReport={canExportReport}
            isExporting={isExporting}
            exportedReportPath={exportedReportPath}
        />
    );
}

interface TestingRunControlsProps {
    isRunning: boolean;
    isCancelling: boolean;
    onCancel: () => void;
}

export function TestingRunControls({ isRunning, isCancelling, onCancel }: TestingRunControlsProps) {
    if (!isRunning) return null;

    return (
        <div className="test-run-controls">
            <button
                type="button"
                className="cancel-run-button"
                onClick={onCancel}
                disabled={isCancelling}
            >
                {isCancelling ? "Stopping…" : "Stop test run"}
            </button>
        </div>
    );
}
