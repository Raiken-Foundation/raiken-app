import { MOD } from "./constants";
import {
    IconButton,
    IconCheck,
    IconClose,
    IconPlay,
    IconPlus,
    IconSave,
    IconSpinner,
    IconTrash,
} from "./icons";
import { StatusDot } from "./status-dot";
import type { TestFile } from "./types";

export function EditorTabs({
    files,
    activeFileId,
    diffTargetPath,
    renamingId,
    renameValue,
    onFileSelect,
    onFileClose,
    onRenameFile,
    setRenameValue,
    startRename,
    commitRename,
    cancelRename,
}: {
    files: TestFile[];
    activeFileId: string;
    diffTargetPath?: string;
    renamingId: string | null;
    renameValue: string;
    onFileSelect: (fileId: string) => void;
    onFileClose?: (fileId: string) => void;
    onRenameFile?: (fileId: string, newName: string) => void;
    setRenameValue: (value: string) => void;
    startRename: (id: string, name: string) => void;
    commitRename: (id: string, currentName: string) => void;
    cancelRename: () => void;
}) {
    return (
        <div className="ce-tabs">
            {files.map((file) => {
                const active = file.id === activeFileId;
                const hasPendingFix = !!diffTargetPath && file.path === diffTargetPath;
                const isRenaming = renamingId === file.id;
                return (
                    <div key={file.id} className={`ce-tab ${active ? "is-active" : ""}`}>
                        {isRenaming ? (
                            <input
                                className="ce-tab-rename"
                                value={renameValue}
                                // biome-ignore lint/a11y/noAutofocus: rename field must grab focus immediately
                                autoFocus
                                spellCheck={false}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitRename(file.id, file.name);
                                    } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        cancelRename();
                                    }
                                }}
                                onBlur={() => commitRename(file.id, file.name)}
                                aria-label={`Rename ${file.name}`}
                            />
                        ) : (
                            <button
                                type="button"
                                className="ce-tab-btn"
                                onClick={() => onFileSelect(file.id)}
                                onDoubleClick={() => {
                                    if (onRenameFile) startRename(file.id, file.name);
                                }}
                                title={
                                    hasPendingFix
                                        ? `${file.path} — AI fix awaiting review`
                                        : onRenameFile
                                          ? `${file.path} — double-click to rename`
                                          : file.path
                                }
                            >
                                <StatusDot status={file.status} />
                                <span className="ce-tab-name">{file.name}</span>
                                {hasPendingFix && (
                                    <span className="ce-tab-fix" title="AI fix awaiting review">
                                        fix
                                    </span>
                                )}
                            </button>
                        )}
                        {onFileClose && (
                            <button
                                type="button"
                                className="ce-tab-x"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onFileClose(file.id);
                                }}
                                aria-label={`Close ${file.name}`}
                                title="Close"
                            >
                                <IconClose />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export function RunSummary({ activeFile }: { activeFile: TestFile }) {
    const passed = activeFile.passedCount;
    const failed = activeFile.failedCount;

    if (passed === undefined && failed === undefined && activeFile.status !== "running") {
        return null;
    }

    return (
        <div className="ce-summary" aria-live="polite">
            {activeFile.status === "running" ? (
                <span className="ce-sum-running">
                    <span className="ce-sum-spinner" aria-hidden="true" />
                    running
                </span>
            ) : (
                <>
                    {failed !== undefined && failed > 0 && (
                        <span
                            className="ce-sum-failed"
                            title={`${failed} test(s) failed in the last run of this file`}
                        >
                            {failed}✗
                        </span>
                    )}
                    {passed !== undefined && (
                        <span
                            className="ce-sum-passed"
                            title={`${passed} test(s) passed in the last run of this file`}
                        >
                            {passed}✓
                        </span>
                    )}
                </>
            )}
        </div>
    );
}

export function DiffReviewActions({
    metaLabel,
    onReject,
    onApply,
    getProposedContent,
}: {
    metaLabel: string;
    onReject?: () => void;
    onApply?: (finalContent: string) => void;
    getProposedContent: () => string;
}) {
    return (
        <div className="ce-actions ce-diff-actions">
            <span className="ce-diff-meta">{metaLabel}</span>
            <button
                type="button"
                className="ce-diff-btn ce-diff-btn--reject"
                onClick={() => onReject?.()}
            >
                Reject
            </button>
            <button
                type="button"
                className="ce-diff-btn ce-diff-btn--apply"
                onClick={() => onApply?.(getProposedContent())}
            >
                Apply fix
            </button>
        </div>
    );
}

export function FileActionsToolbar({
    activeFile,
    onNewFile,
    onSaveFile,
    onDeleteFile,
    onRunTests,
    isSaving,
    isRunningTests,
    showSavedFlash,
    confirmDelete,
    setConfirmDelete,
    confirmRef,
}: {
    activeFile: TestFile;
    onNewFile?: () => void;
    onSaveFile?: (fileId: string) => void;
    onDeleteFile?: (fileId: string) => void;
    onRunTests?: (fileId: string) => void;
    isSaving?: boolean;
    isRunningTests?: boolean;
    showSavedFlash: boolean;
    confirmDelete: boolean;
    setConfirmDelete: React.Dispatch<React.SetStateAction<boolean>>;
    confirmRef: React.RefObject<HTMLDivElement | null>;
}) {
    const isScratch = activeFile.path.startsWith("scratch:");

    return (
        <>
            <div className="ce-rule" aria-hidden="true" />
            <div className="ce-actions" role="toolbar" aria-label="File actions">
                {onNewFile && (
                    <IconButton label={`New file (${MOD}N)`} onClick={onNewFile}>
                        <IconPlus />
                    </IconButton>
                )}
                {onSaveFile && (
                    <IconButton
                        label={
                            isScratch ? "Save (use Save As… for scratch files)" : `Save (${MOD}S)`
                        }
                        onClick={() => onSaveFile(activeFile.id)}
                        disabled={isSaving}
                        state={isSaving ? "loading" : showSavedFlash ? "success" : undefined}
                    >
                        {isSaving ? <IconSpinner /> : showSavedFlash ? <IconCheck /> : <IconSave />}
                    </IconButton>
                )}
                {onDeleteFile && (
                    <div className="ce-confirm-anchor">
                        <IconButton
                            label="Delete file"
                            onClick={() => setConfirmDelete((v) => !v)}
                            tone={confirmDelete ? "danger-active" : undefined}
                        >
                            <IconTrash />
                        </IconButton>
                        {confirmDelete && (
                            <div className="ce-confirm" role="dialog" ref={confirmRef}>
                                <p>
                                    Delete <span className="ce-mono">{activeFile.name}</span>?
                                </p>
                                <span className="ce-confirm-hint">
                                    {isScratch
                                        ? "This scratch buffer will be discarded."
                                        : "This will remove the file from disk."}
                                </span>
                                <div className="ce-confirm-row">
                                    <button
                                        type="button"
                                        className="ce-confirm-btn"
                                        onClick={() => setConfirmDelete(false)}
                                    >
                                        cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="ce-confirm-btn ce-confirm-btn--danger"
                                        onClick={() => {
                                            setConfirmDelete(false);
                                            onDeleteFile(activeFile.id);
                                        }}
                                        ref={(el) => {
                                            if (el && confirmDelete) el.focus();
                                        }}
                                    >
                                        delete
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {onRunTests && (
                    <IconButton
                        label={isRunningTests ? "Running…" : `Run tests (${MOD}↵)`}
                        onClick={() => onRunTests(activeFile.id)}
                        disabled={isRunningTests}
                        tone="run"
                        state={isRunningTests ? "loading" : undefined}
                    >
                        {isRunningTests ? <IconSpinner /> : <IconPlay />}
                    </IconButton>
                )}
            </div>
        </>
    );
}
