import { useState } from "react";
import { Header } from "../../components/header";
import { TicketSyncBar } from "../../components/ticket-sync";
import { TestingEditorPane } from "./testing-editor-pane";
import { TestingResultsPane, TestingRunControls } from "./testing-results-pane";
import { TestingSidebarPane } from "./testing-sidebar-pane";
import type { TestingViewProps } from "./types";
import { useCodeGraph } from "./use-code-graph";
import { useSidebarResize } from "./use-sidebar-resize";
import { useTestFiles } from "./use-test-files";
import { useTestMutations } from "./use-test-mutations";
import { useTestRepair } from "./use-test-repair";
import { useTestRun } from "./use-test-run";
import "./testing.css";

export function TestingScreen({
    sidebarTab = "chat",
    sidebarCollapsed = false,
    onSidebarTabChange,
    pendingPrompt,
    onPromptConsumed,
    onNavigateRoute,
    onHitlPendingChange,
}: TestingViewProps) {
    const [ticketPrompt, setTicketPrompt] = useState<string | undefined>();

    const codeGraph = useCodeGraph();
    const sidebar = useSidebarResize();
    const files = useTestFiles();

    const mutations = useTestMutations({
        files: files.files,
        setFiles: files.setFiles,
        activeFileId: files.activeFileId,
        setActiveFileId: files.setActiveFileId,
        activeFilePath: files.activeFilePath,
        setActiveFilePath: files.setActiveFilePath,
        closedPathsRef: files.closedPathsRef,
        savedContentRef: files.savedContentRef,
        handleFileClose: files.handleFileClose,
    });

    const run = useTestRun({
        files: files.files,
        setFiles: files.setFiles,
        activeFileId: files.activeFileId,
        setActiveFilePath: files.setActiveFilePath,
        closedPathsRef: files.closedPathsRef,
        skipDiskLoadRef: files.skipDiskLoadRef,
        savedContentRef: files.savedContentRef,
        persistOnRunMutation: mutations.persistOnRunMutation,
    });

    const repair = useTestRepair({
        filesRef: files.filesRef,
        setActiveFileId: files.setActiveFileId,
        setActiveFilePath: files.setActiveFilePath,
        lastRunTestPath: run.lastRunTestPath,
        lastRunTestCode: run.lastRunTestCode,
        rawTestOutput: run.rawTestOutput,
        activeFilePath: files.activeFilePath,
        openProposedTest: files.openProposedTest,
        lastReportJsonRef: run.lastReportJsonRef,
    });

    return (
        <div className="testing-view" data-testing-mounted="true">
            <Header projectName={codeGraph.projectInfo?.path?.split("/").pop() || "raiken-app"} />
            <TicketSyncBar
                onGenerateTest={(prompt) => {
                    onSidebarTabChange?.("chat");
                    setTicketPrompt(prompt);
                }}
            />

            <div className="main-content">
                <TestingSidebarPane
                    sidebarWidth={sidebar.sidebarWidth}
                    isResizing={sidebar.isResizing}
                    onMouseDown={sidebar.handleMouseDown}
                    onResizeKeyDown={sidebar.handleResizeKeyDown}
                    onSendMessage={mutations.handleSendMessage}
                    onFileSelect={files.handleFileSelectByPath}
                    activeFilePath={files.activeFilePath}
                    sidebarTab={sidebarTab}
                    sidebarCollapsed={sidebarCollapsed}
                    onSidebarTabChange={onSidebarTabChange}
                    onNavigateRoute={onNavigateRoute}
                    onHitlPendingChange={onHitlPendingChange}
                    initialPrompt={ticketPrompt || pendingPrompt}
                    onInitialPromptConsumed={() => {
                        if (ticketPrompt) setTicketPrompt(undefined);
                        onPromptConsumed?.();
                    }}
                />

                <TestingEditorPane
                    displayFiles={files.displayFiles}
                    activeFileId={files.activeFileId}
                    isIndexing={codeGraph.isIndexing}
                    isBuilding={codeGraph.isBuilding}
                    graphBuildError={codeGraph.graphBuildError}
                    onRetryGraphBuild={codeGraph.handleRetryGraphBuild}
                    onFileSelect={files.handleFileSelect}
                    onFileClose={files.handleFileClose}
                    onContentChange={files.handleContentChange}
                    onRunTests={run.handleRunTests}
                    onNewFile={files.handleNewFile}
                    onSaveFile={mutations.handleSaveFile}
                    onRenameFile={mutations.handleRenameFile}
                    onDeleteFile={mutations.handleDeleteFile}
                    isRunningTests={run.isRunningTests}
                    isSaving={mutations.isSavingFile}
                    savedFileId={mutations.savedFileId}
                    diffReview={repair.diffReview}
                    onApplyDiff={repair.handleApplyDiff}
                    onRejectDiff={repair.handleRejectDiff}
                />
            </div>

            <TestingRunControls
                isRunning={run.isRunningTests}
                isCancelling={run.cancelTestRunMutation.isPending}
                onCancel={() => run.cancelTestRunMutation.mutate({})}
            />

            <TestingResultsPane
                results={run.testResults}
                summary={run.testSummary}
                filePath={run.lastRunTestPath || files.activeFile?.path}
                isRunning={run.isRunningTests}
                rawOutput={run.rawTestOutput}
                testCode={run.lastRunTestCode}
                onRequestInterpretation={repair.handleRequestInterpretation}
                interpretation={repair.interpretation}
                interpretationSource={repair.interpretationSource}
                isInterpreting={repair.isInterpreting}
                onRequestFix={repair.handleRequestFix}
                isFixing={repair.isFixing}
                fixError={repair.fixError}
                onExportReport={repair.handleExportReport}
                canExportReport={run.canExportReport}
                isExporting={repair.isExporting}
                exportedReportPath={repair.exportedReportPath}
            />
        </div>
    );
}

export default TestingScreen;
