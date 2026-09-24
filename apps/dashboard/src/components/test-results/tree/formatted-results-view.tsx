import type { TestResult } from "../types";
import { TestDetailsPanel } from "../tree/failure-details";
import { TestList } from "../tree/test-list";
import { FixErrorAlert, FixTestButton, InlineAnalyzeButton } from "../analysis/repair-actions";

interface FormattedResultsViewProps {
    results: TestResult[];
    selectedTest: string | null;
    selectedTestDetails: TestResult | null | undefined;
    failedCount: number;
    onSelectTest: (testId: string | null) => void;
    onRequestFix?: (results: TestResult[]) => void;
    onRequestInterpretation?: (results: TestResult[]) => void;
    onAnalyzeClick: () => void;
    testCode?: string;
    isFixing?: boolean;
    isInterpreting?: boolean;
    fixError?: string | null;
    summaryBar: React.ReactNode;
}

export function FormattedResultsView({
    results,
    selectedTest,
    selectedTestDetails,
    failedCount,
    onSelectTest,
    onRequestFix,
    onRequestInterpretation,
    onAnalyzeClick,
    testCode,
    isFixing,
    isInterpreting,
    fixError,
    summaryBar,
}: FormattedResultsViewProps) {
    return (
        <div className="formatted-results">
            {failedCount > 0 && (onRequestFix || (onRequestInterpretation && testCode)) ? (
                <div className="results-actions">
                    <span className="results-actions-label">{failedCount} failing —</span>
                    {onRequestFix ? (
                        <FixTestButton
                            label="Fix with AI"
                            isFixing={isFixing}
                            onClick={() => onRequestFix(results)}
                        />
                    ) : null}
                    {onRequestInterpretation && testCode ? (
                        <InlineAnalyzeButton
                            isInterpreting={isInterpreting}
                            onClick={onAnalyzeClick}
                        />
                    ) : null}
                    {fixError ? <FixErrorAlert message={fixError} /> : null}
                </div>
            ) : null}

            <TestList results={results} selectedTest={selectedTest} onSelectTest={onSelectTest} />

            {selectedTestDetails ? <TestDetailsPanel test={selectedTestDetails} /> : null}

            {summaryBar}
        </div>
    );
}
