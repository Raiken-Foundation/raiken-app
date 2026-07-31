import { CodeEditor, type DiffReview, type TestFile } from "../../components/code-editor";

interface TestingEditorPaneProps {
    displayFiles: TestFile[];
    activeFileId: string;
    isIndexing: boolean;
    isBuilding: boolean;
    graphBuildError: string | null;
    onRetryGraphBuild: () => void;
    onFileSelect: (fileId: string) => void;
    onFileClose: (fileId: string) => void;
    onContentChange: (fileId: string, content: string) => void;
    onRunTests: (fileId: string) => void;
    onNewFile: () => void;
    onSaveFile: (fileId: string) => void;
    onRenameFile: (fileId: string, newName: string) => void;
    onDeleteFile: (fileId: string) => void;
    isRunningTests: boolean;
    isSaving: boolean;
    savedFileId: string | null;
    diffReview: DiffReview | null;
    onApplyDiff: (finalContent: string) => void;
    onRejectDiff: () => void;
}

export function TestingEditorPane({
    displayFiles,
    activeFileId,
    isIndexing,
    isBuilding,
    graphBuildError,
    onRetryGraphBuild,
    onFileSelect,
    onFileClose,
    onContentChange,
    onRunTests,
    onNewFile,
    onSaveFile,
    onRenameFile,
    onDeleteFile,
    isRunningTests,
    isSaving,
    savedFileId,
    diffReview,
    onApplyDiff,
    onRejectDiff,
}: TestingEditorPaneProps) {
    return (
        <div className="editor-section">
            {isIndexing && (
                <div className="indexing-banner" aria-live="polite">
                    <span className="indexing-spinner" aria-hidden="true" />
                    <span>{isBuilding ? "building code graph…" : "loading files…"}</span>
                </div>
            )}
            {graphBuildError && !isBuilding && (
                <div className="indexing-banner indexing-error" role="alert">
                    <span>Code graph build failed: {graphBuildError}</span>
                    <button type="button" onClick={onRetryGraphBuild}>
                        Retry
                    </button>
                </div>
            )}
            <CodeEditor
                files={displayFiles}
                activeFileId={activeFileId}
                onFileSelect={onFileSelect}
                onFileClose={onFileClose}
                onContentChange={onContentChange}
                onRunTests={onRunTests}
                onNewFile={onNewFile}
                onSaveFile={onSaveFile}
                onRenameFile={onRenameFile}
                onDeleteFile={onDeleteFile}
                isRunningTests={isRunningTests}
                isSaving={isSaving}
                savedFileId={savedFileId}
                diffReview={diffReview}
                onApplyDiff={onApplyDiff}
                onRejectDiff={onRejectDiff}
            />
        </div>
    );
}
