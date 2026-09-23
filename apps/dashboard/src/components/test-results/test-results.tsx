import { useEffect, useMemo, useState } from "react";
import { InsightsView } from "./analysis/insights-view";
import { ArtifactsView } from "./artifacts/artifacts-view";
import {
    buildResultStateKey,
    buildSuiteTree,
    categorizeArtifacts,
    flattenSuiteTree,
    partitionResults,
} from "./model/report-model";
import { EmptyState, RunningState } from "./summary/status-states";
import { ResultsHeader } from "./summary/results-header";
import { SummaryBar } from "./summary/summary-bar";
import { FormattedResultsView } from "./tree/formatted-results-view";
import type { TestResultsProps, TestResultsViewMode } from "./types";
import { RawOutputView } from "./view/raw-output-view";
import { ViewToggle } from "./view/view-toggle";
import "./test-results.css";

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
    onRequestFix,
    isFixing,
    fixError,
    onExportReport,
    canExportReport = true,
    isExporting,
    exportedReportPath,
}: TestResultsProps) {
    void _filePath;
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedTest, setSelectedTest] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<TestResultsViewMode>("formatted");
    const [exportMarkdown, setExportMarkdown] = useState(false);

    const { failed, passed } = partitionResults(results);
    const hasResults = results.length > 0;
    const resultStateKey = buildResultStateKey(results);

    const orderedResults = useMemo(
        () => flattenSuiteTree(buildSuiteTree(results)),
        [results],
    );
    const artifacts = useMemo(() => categorizeArtifacts(results), [results]);

    useEffect(() => {
        if (results.length > 0) {
            setIsExpanded(true);
            setSelectedTest(failed[0]?.id ?? null);
        } else {
            setSelectedTest(null);
        }
    }, [resultStateKey]);

    useEffect(() => {
        if (isRunning) setIsExpanded(true);
    }, [isRunning]);

    const handleAnalyzeClick = () => {
        if (onRequestInterpretation && testCode && !isInterpreting) {
            onRequestInterpretation(results);
            setViewMode("insights");
        }
    };

    const handleFixClick = () => {
        if (onRequestFix && !isFixing) {
            onRequestFix(results);
        }
    };

    const selectedTestDetails = selectedTest
        ? results.find((result) => result.id === selectedTest)
        : null;

    const showContent = !isRunning && (hasResults || rawOutput);

    return (
        <div className={`test-results ${isExpanded ? "expanded" : "collapsed"}`}>
            <ResultsHeader
                isExpanded={isExpanded}
                hasResults={hasResults}
                isRunning={Boolean(isRunning)}
                passedCount={passed.length}
                failedCount={failed.length}
                timeSeconds={summary.time}
                onToggle={() => setIsExpanded(!isExpanded)}
            />

            {isExpanded ? (
                <div className="results-content">
                    {isRunning ? <RunningState /> : null}

                    {!isRunning && !hasResults && !rawOutput ? <EmptyState /> : null}

                    {showContent ? (
                        <ViewToggle
                            viewMode={viewMode}
                            onViewModeChange={setViewMode}
                            hasResults={hasResults}
                            rawOutput={rawOutput}
                            testCode={testCode}
                            onExportReport={onExportReport}
                            canExportReport={canExportReport}
                            isExporting={isExporting}
                            exportMarkdown={exportMarkdown}
                            onExportMarkdownChange={setExportMarkdown}
                            onRequestInterpretation={handleAnalyzeClick}
                            isInterpreting={isInterpreting}
                        />
                    ) : null}

                    {exportedReportPath ? (
                        <div className="export-report-note">
                            Report saved to <code>{exportedReportPath}</code>
                        </div>
                    ) : null}

                    {!isRunning && viewMode === "artifacts" ? (
                        <div className="artifacts-view">
                            <ArtifactsView artifacts={artifacts} />
                        </div>
                    ) : null}

                    {!isRunning && viewMode === "raw" && rawOutput ? (
                        <RawOutputView rawOutput={rawOutput} />
                    ) : null}

                    {!isRunning && viewMode === "insights" ? (
                        <InsightsView
                            isInterpreting={isInterpreting}
                            interpretation={interpretation}
                            interpretationSource={interpretationSource}
                            failedCount={failed.length}
                            testCode={testCode}
                            onRequestInterpretation={onRequestInterpretation}
                            onRequestFix={onRequestFix}
                            onAnalyzeClick={handleAnalyzeClick}
                            onFixClick={handleFixClick}
                            isFixing={isFixing}
                            fixError={fixError}
                            results={results}
                        />
                    ) : null}

                    {!isRunning && viewMode === "formatted" && hasResults ? (
                        <FormattedResultsView
                            results={orderedResults}
                            selectedTest={selectedTest}
                            selectedTestDetails={selectedTestDetails}
                            failedCount={failed.length}
                            onSelectTest={setSelectedTest}
                            onRequestFix={onRequestFix}
                            onRequestInterpretation={onRequestInterpretation}
                            onAnalyzeClick={handleAnalyzeClick}
                            testCode={testCode}
                            isFixing={isFixing}
                            isInterpreting={isInterpreting}
                            fixError={fixError}
                            summaryBar={<SummaryBar summary={summary} />}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
