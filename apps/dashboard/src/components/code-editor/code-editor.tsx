import "./code-editor.css";
import { EditorEmptyState, EditorSelectFileHint } from "./editor-empty-state";
import { DiffReviewActions, EditorTabs, FileActionsToolbar, RunSummary } from "./editor-toolbar";
import { getDiffMetaLabel, shouldShowDiff } from "./helpers";
import { DiffMatchFailedBanner, MonacoDiffPane } from "./monaco-diff-pane";
import { MonacoEditorPane } from "./monaco-editor-pane";
import type { CodeEditorProps } from "./types";
import { useEditorState } from "./use-editor-state";

export function CodeEditor({
    files,
    activeFileId,
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
}: CodeEditorProps) {
    const activeFile = files.find((f) => f.id === activeFileId);
    const editorState = useEditorState({
        activeFileId,
        savedFileId,
        diffReview,
        onSaveFile,
        onRunTests,
        onRenameFile,
        isRunningTests,
    });

    const diffTargetPath = diffReview?.targetPath;
    const showDiff = shouldShowDiff(diffReview, activeFile);
    const diffMetaLabel = getDiffMetaLabel(diffReview);

    if (files.length === 0 && !diffReview) {
        return <EditorEmptyState onNewFile={onNewFile} />;
    }

    const handleEditorChange = (value: string | undefined) => {
        if (value !== undefined && onContentChange) {
            onContentChange(activeFileId, value);
        }
    };

    return (
        <div className="ce-shell">
            <div className="ce-bar">
                <EditorTabs
                    files={files}
                    activeFileId={activeFileId}
                    diffTargetPath={diffTargetPath}
                    renamingId={editorState.renamingId}
                    renameValue={editorState.renameValue}
                    onFileSelect={onFileSelect}
                    onFileClose={onFileClose}
                    onRenameFile={onRenameFile}
                    setRenameValue={editorState.setRenameValue}
                    startRename={editorState.startRename}
                    commitRename={editorState.commitRename}
                    cancelRename={editorState.cancelRename}
                />

                <div className="ce-spacer" />

                {!showDiff && activeFile && <RunSummary activeFile={activeFile} />}

                {showDiff ? (
                    <DiffReviewActions
                        metaLabel={diffMetaLabel}
                        onReject={onRejectDiff}
                        onApply={onApplyDiff}
                        getProposedContent={() => editorState.diffModifiedRef.current}
                    />
                ) : (
                    activeFile && (
                        <FileActionsToolbar
                            activeFile={activeFile}
                            onNewFile={onNewFile}
                            onSaveFile={onSaveFile}
                            onDeleteFile={onDeleteFile}
                            onRunTests={onRunTests}
                            isSaving={isSaving}
                            isRunningTests={isRunningTests}
                            showSavedFlash={editorState.showSavedFlash}
                            confirmDelete={editorState.confirmDelete}
                            setConfirmDelete={editorState.setConfirmDelete}
                            confirmRef={editorState.confirmRef}
                        />
                    )
                )}
            </div>

            {showDiff && diffReview && diffReview.matchFailed && <DiffMatchFailedBanner />}

            {showDiff && diffReview ? (
                <MonacoDiffPane
                    diffReview={diffReview}
                    isReady={editorState.isDiffReady}
                    diffModifiedRef={editorState.diffModifiedRef}
                    onReady={() => editorState.setIsDiffReady(true)}
                />
            ) : activeFile ? (
                <MonacoEditorPane
                    fileName={activeFile.name}
                    content={activeFile.content}
                    isReady={editorState.isEditorReady}
                    onReady={() => editorState.setIsEditorReady(true)}
                    onChange={handleEditorChange}
                />
            ) : (
                <div className="ce-editor">
                    <EditorSelectFileHint />
                </div>
            )}
        </div>
    );
}

export type { CodeEditorProps, DiffReview, TestFile } from "./types";
