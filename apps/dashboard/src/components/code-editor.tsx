import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface TestFile {
    id: string;
    name: string;
    path: string;
    content: string;
    status: "passed" | "failed" | "running" | "pending";
    passedCount?: number;
    failedCount?: number;
    language?: string;
}

/**
 * A proposed AI edit awaiting review. Rendered as an original-vs-proposed
 * Monaco diff with Apply / Reject, so the developer sees exactly which
 * sections changed instead of a silent buffer swap.
 */
export interface DiffReview {
    fileName: string;
    /**
     * Path of the file the fix targets. Used to tie the diff to a single tab so
     * the rest of the editor (other tabs) stays navigable while it's pending.
     */
    targetPath: string;
    /** Current on-disk / buffer content (left side). */
    original: string;
    /** AI-proposed content (right side, editable before applying). */
    proposed: string;
    /** Number of section edits applied (null / 0 for a full rewrite). */
    editCount: number | null;
    mode: "edits" | "full" | null;
    /** True when section edits couldn't be matched and we fell back to a full rewrite. */
    matchFailed: boolean;
}

function defineRaikenTheme(monaco: Monaco) {
    monaco.editor.defineTheme("raiken-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": "#0a0a0a",
            "editor.lineHighlightBackground": "#141414",
            "editorLineNumber.foreground": "#3a3a3a",
            "editorLineNumber.activeForeground": "#9ca3af",
            "editor.selectionBackground": "#2a2440",
            "editorCursor.foreground": "#a78bfa",
        },
    });
}

interface CodeEditorProps {
    files: TestFile[];
    activeFileId: string;
    onFileSelect: (fileId: string) => void;
    onFileClose?: (fileId: string) => void;
    onContentChange?: (fileId: string, content: string) => void;
    onRunTests?: (fileId: string) => void;
    onNewFile?: () => void;
    onSaveFile?: (fileId: string) => void;
    /** Rename a file (double-click a tab name). Receives the raw typed name. */
    onRenameFile?: (fileId: string, newName: string) => void;
    onDeleteFile?: (fileId: string) => void;
    isRunningTests?: boolean;
    isSaving?: boolean;
    savedFileId?: string | null;
    /** When set, the editor shows an AI-fix diff for review instead of the file. */
    diffReview?: DiffReview | null;
    /** Apply the (possibly hand-tweaked) proposed content. */
    onApplyDiff?: (finalContent: string) => void;
    /** Discard the proposed fix. */
    onRejectDiff?: () => void;
}

const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
const MOD = isMac ? "⌘" : "Ctrl+";

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
    const [isEditorReady, setIsEditorReady] = useState(false);
    const [showSavedFlash, setShowSavedFlash] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const confirmRef = useRef<HTMLDivElement | null>(null);

    // Inline tab rename. Double-click a tab name to edit it; Enter/blur commits,
    // Esc cancels. The ref guards against a double-commit (Enter then blur).
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const renameActiveRef = useRef(false);
    const startRename = (id: string, name: string) => {
        renameActiveRef.current = true;
        setRenamingId(id);
        setRenameValue(name);
    };
    const commitRename = (id: string, currentName: string) => {
        if (!renameActiveRef.current) return;
        renameActiveRef.current = false;
        setRenamingId(null);
        const v = renameValue.trim();
        if (v && v !== currentName) onRenameFile?.(id, v);
    };
    const cancelRename = () => {
        renameActiveRef.current = false;
        setRenamingId(null);
    };

    // Pending AI-fix diff state. The modified (right) side is editable before
    // Apply; we read the latest value from this ref rather than re-rendering on
    // every keystroke. Reset whenever a new proposal arrives.
    const [isDiffReady, setIsDiffReady] = useState(false);
    const diffModifiedRef = useRef("");
    useEffect(() => {
        diffModifiedRef.current = diffReview?.proposed ?? "";
        setIsDiffReady(false);
    }, [diffReview?.proposed, diffReview?.targetPath]);

    useEffect(() => {
        if (savedFileId === activeFileId && savedFileId) {
            setShowSavedFlash(true);
            const t = setTimeout(() => setShowSavedFlash(false), 1500);
            return () => clearTimeout(t);
        }
    }, [savedFileId, activeFileId]);

    // Dismiss delete-confirm on outside click / Escape
    useEffect(() => {
        if (!confirmDelete) return;
        const onClick = (e: MouseEvent) => {
            if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
                setConfirmDelete(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setConfirmDelete(false);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [confirmDelete]);

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                if (onSaveFile && activeFileId) onSaveFile(activeFileId);
            }
            // ⌘⏎ runs the current test file
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (onRunTests && activeFileId && !isRunningTests) {
                    onRunTests(activeFileId);
                }
            }
        },
        [onSaveFile, onRunTests, activeFileId, isRunningTests],
    );

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);

    const handleEditorChange = (value: string | undefined) => {
        if (value !== undefined && onContentChange) {
            onContentChange(activeFileId, value);
        }
    };

    // A pending AI-fix diff is shown ONLY while the user is on its target file's
    // tab (or nothing is open). Navigating to any other tab reveals that file
    // normally, so a pending fix no longer traps the whole editor. The target
    // tab is badged so the review stays discoverable.
    const diffTargetPath = diffReview?.targetPath;
    const showDiff = !!diffReview && (!activeFile || activeFile.path === diffTargetPath);
    const diffIsEdits = diffReview?.mode === "edits" && !!diffReview?.editCount;
    const diffMetaLabel = diffReview
        ? diffIsEdits
            ? `${diffReview.editCount} section edit${diffReview.editCount === 1 ? "" : "s"}`
            : "full rewrite"
        : "";

    // Empty state — only when there's genuinely nothing to show (no files AND
    // no pending diff). With a pending diff we still render the shell below.
    if (files.length === 0 && !diffReview) {
        return (
            <div className="ce-shell">
                <div className="ce-empty">
                    <pre className="ce-empty-prompt" aria-hidden="true">
                        $ raiken — no file open
                    </pre>
                    <p className="ce-empty-hint">
                        Open a spec from the sidebar
                        {onNewFile && (
                            <>
                                {" "}
                                or{" "}
                                <button type="button" className="ce-empty-link" onClick={onNewFile}>
                                    create a new file
                                </button>
                            </>
                        )}
                        .
                    </p>
                </div>
                <CodeEditorStyles />
            </div>
        );
    }

    const language = activeFile ? getLanguage(activeFile.name) : "typescript";
    const passed = activeFile?.passedCount;
    const failed = activeFile?.failedCount;
    const isScratch = activeFile?.path.startsWith("scratch:") ?? false;

    return (
        <div className="ce-shell">
            {/* ---------- Single combined toolbar ---------- */}
            <div className="ce-bar">
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
                                            <span
                                                className="ce-tab-fix"
                                                title="AI fix awaiting review"
                                            >
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

                <div className="ce-spacer" />

                {/* Inline run summary — replaces the bottom results bar */}
                {!showDiff &&
                    activeFile &&
                    (passed !== undefined ||
                        failed !== undefined ||
                        activeFile.status === "running") && (
                        <div className="ce-summary" aria-live="polite">
                            {activeFile.status === "running" ? (
                                <span className="ce-sum-running">
                                    <span className="ce-sum-spinner" aria-hidden="true" />
                                    running
                                </span>
                            ) : (
                                <>
                                    {failed !== undefined && failed > 0 && (
                                        <span className="ce-sum-failed">{failed}✗</span>
                                    )}
                                    {passed !== undefined && (
                                        <span className="ce-sum-passed">{passed}✓</span>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                {showDiff ? (
                    /* Diff review actions replace the file actions while a fix is
                       pending on THIS tab — other tabs keep their normal bar. */
                    <div className="ce-actions ce-diff-actions">
                        <span className="ce-diff-meta">{diffMetaLabel}</span>
                        <button
                            type="button"
                            className="ce-diff-btn ce-diff-btn--reject"
                            onClick={() => onRejectDiff?.()}
                        >
                            Reject
                        </button>
                        <button
                            type="button"
                            className="ce-diff-btn ce-diff-btn--apply"
                            onClick={() => onApplyDiff?.(diffModifiedRef.current)}
                        >
                            Apply fix
                        </button>
                    </div>
                ) : (
                    activeFile && (
                        <>
                            <div className="ce-rule" aria-hidden="true" />

                            {/* Icon-only actions */}
                            <div className="ce-actions" role="toolbar" aria-label="File actions">
                                {onNewFile && (
                                    <IconButton label={`New file (${MOD}N)`} onClick={onNewFile}>
                                        <IconPlus />
                                    </IconButton>
                                )}
                                {onSaveFile && (
                                    <IconButton
                                        label={
                                            isScratch
                                                ? "Save (use Save As… for scratch files)"
                                                : `Save (${MOD}S)`
                                        }
                                        onClick={() => onSaveFile(activeFile.id)}
                                        disabled={isSaving}
                                        state={
                                            isSaving
                                                ? "loading"
                                                : showSavedFlash
                                                  ? "success"
                                                  : undefined
                                        }
                                    >
                                        {isSaving ? (
                                            <IconSpinner />
                                        ) : showSavedFlash ? (
                                            <IconCheck />
                                        ) : (
                                            <IconSave />
                                        )}
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
                                            <div
                                                className="ce-confirm"
                                                role="dialog"
                                                ref={confirmRef}
                                            >
                                                <p>
                                                    Delete{" "}
                                                    <span className="ce-mono">
                                                        {activeFile.name}
                                                    </span>
                                                    ?
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
                    )
                )}
            </div>

            {showDiff && diffReview && diffReview.matchFailed && (
                <div className="ce-diff-warn" role="alert">
                    Some section edits couldn&apos;t be matched to the current file, so this is a
                    full rewrite — review carefully before applying.
                </div>
            )}

            {/* ---------- Editor / Diff ---------- */}
            {showDiff && diffReview ? (
                <div className="ce-editor">
                    {!isDiffReady && (
                        <div className="ce-loading">
                            <span className="ce-loading-spin" aria-hidden="true" />
                            <span>loading diff</span>
                        </div>
                    )}
                    <DiffEditor
                        height="100%"
                        language={getLanguage(diffReview.fileName)}
                        original={diffReview.original}
                        modified={diffReview.proposed}
                        theme="vs-dark"
                        beforeMount={defineRaikenTheme}
                        onMount={(editor, monaco) => {
                            monaco.editor.setTheme("raiken-dark");
                            const modified = editor.getModifiedEditor();
                            diffModifiedRef.current = modified.getValue();
                            modified.onDidChangeModelContent(() => {
                                diffModifiedRef.current = modified.getValue();
                            });
                            setIsDiffReady(true);
                        }}
                        options={{
                            renderSideBySide: true,
                            readOnly: false,
                            originalEditable: false,
                            minimap: { enabled: false },
                            fontSize: 13,
                            lineHeight: 22,
                            fontFamily:
                                "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
                            fontLigatures: true,
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            renderOverviewRuler: false,
                            scrollbar: {
                                vertical: "auto",
                                horizontal: "auto",
                                verticalScrollbarSize: 8,
                                horizontalScrollbarSize: 8,
                            },
                        }}
                    />
                </div>
            ) : activeFile ? (
                <div className="ce-editor">
                    {!isEditorReady && (
                        <div className="ce-loading">
                            <span className="ce-loading-spin" aria-hidden="true" />
                            <span>loading editor</span>
                        </div>
                    )}
                    <Editor
                        height="100%"
                        language={language}
                        value={activeFile.content || ""}
                        theme="vs-dark"
                        beforeMount={defineRaikenTheme}
                        onMount={(_editor, monaco) => {
                            monaco.editor.setTheme("raiken-dark");
                            setIsEditorReady(true);
                        }}
                        onChange={handleEditorChange}
                        options={{
                            minimap: { enabled: false },
                            fontSize: 13,
                            lineHeight: 22,
                            fontFamily:
                                "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
                            fontLigatures: true,
                            padding: { top: 12, bottom: 12 },
                            scrollBeyondLastLine: false,
                            lineNumbers: "on",
                            renderLineHighlight: "line",
                            cursorStyle: "line",
                            automaticLayout: true,
                            scrollbar: {
                                vertical: "auto",
                                horizontal: "auto",
                                verticalScrollbarSize: 8,
                                horizontalScrollbarSize: 8,
                            },
                            overviewRulerBorder: false,
                            hideCursorInOverviewRuler: true,
                            glyphMargin: false,
                            folding: true,
                            lineDecorationsWidth: 10,
                            lineNumbersMinChars: 4,
                        }}
                    />
                </div>
            ) : (
                <div className="ce-editor">
                    <div className="ce-empty">
                        <p className="ce-empty-hint">Select a file from the tabs above.</p>
                    </div>
                </div>
            )}

            <CodeEditorStyles />
        </div>
    );
}

// ---------- Icon button primitive ------------------------------------------

function IconButton({
    label,
    onClick,
    children,
    disabled,
    state,
    tone,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
    disabled?: boolean;
    state?: "loading" | "success";
    tone?: "run" | "danger-active";
}) {
    const cls = ["ce-icon-btn", tone ? `ce-icon-btn--${tone}` : "", state ? `is-${state}` : ""]
        .filter(Boolean)
        .join(" ");
    return (
        <button
            type="button"
            className={cls}
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
        >
            {children}
        </button>
    );
}

// ---------- Status dot inside tabs -----------------------------------------

function StatusDot({ status }: { status: TestFile["status"] }) {
    return <span className={`ce-dot ce-dot--${status}`} aria-hidden="true" />;
}

// ---------- Icons ----------------------------------------------------------
// Single-stroke 14px monoline icons, no fill.

// Decorative icons: parent <button> always carries the accessible label/title.
function IconClose() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}
function IconPlus() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M8 3v10M3 8h10" />
        </svg>
    );
}
function IconSave() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 3h8l2 2v8H3V3z" />
            <path d="M5 3v3h5V3" />
            <path d="M5 9h6v4H5z" />
        </svg>
    );
}
function IconCheck() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 8.5l3 3 7-7" />
        </svg>
    );
}
function IconTrash() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9" />
        </svg>
    );
}
function IconPlay() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M5 3.5l7 4.5-7 4.5V3.5z" />
        </svg>
    );
}
function IconSpinner() {
    return (
        <svg
            className="ce-spin"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M8 2a6 6 0 1 1-6 6" />
        </svg>
    );
}

// ---------- Helpers --------------------------------------------------------

function getLanguage(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        css: "css",
        scss: "scss",
        html: "html",
        md: "markdown",
    };
    return map[ext || ""] || "typescript";
}

// ---------- Styles ---------------------------------------------------------

function CodeEditorStyles() {
    return (
        <style>{`
            .ce-shell {
                --bg: #0a0a0a;
                --bg-bar: #0d0d0d;
                --bg-hover: #181818;
                --bg-active: #0a0a0a;
                --hair: #1c1c1c;
                --hair-soft: #161616;
                --ink: #d4d4d4;
                --ink-dim: #8a8a8a;
                --ink-faint: #5a5a5a;
                --accent: #a78bfa;
                --accent-dim: rgba(167, 139, 250, 0.18);
                --pass: #6fb86f;
                --fail: #d75c5c;
                --run: #6fa3c6;
                --danger: #d75c5c;

                --mono: "JetBrains Mono", ui-monospace, SFMono-Regular,
                    Menlo, Consolas, monospace;

                flex: 1;
                display: flex;
                flex-direction: column;
                background: var(--bg);
                overflow: hidden;
                min-height: 0;
                font-family: var(--mono);
                color: var(--ink);
            }

            /* ---------- Toolbar ---------- */
            .ce-bar {
                display: flex;
                align-items: stretch;
                background: var(--bg-bar);
                border-bottom: 1px solid var(--hair);
                flex-shrink: 0;
                min-height: 34px;
            }
            .ce-tabs {
                display: flex;
                align-items: stretch;
                overflow-x: auto;
                scrollbar-width: thin;
                min-width: 0;
            }
            .ce-tabs::-webkit-scrollbar { height: 6px; }
            .ce-tabs::-webkit-scrollbar-thumb { background: var(--hair); }

            .ce-tab {
                display: flex;
                align-items: center;
                position: relative;
                border-right: 1px solid var(--hair);
                background: transparent;
                color: var(--ink-faint);
                white-space: nowrap;
            }
            .ce-tab:hover { color: var(--ink-dim); background: var(--hair-soft); }
            .ce-tab.is-active {
                background: var(--bg-active);
                color: var(--ink);
            }
            .ce-tab.is-active::before {
                content: "";
                position: absolute;
                left: 0; right: 0; top: 0;
                height: 1px;
                background: var(--accent);
            }
            .ce-tab-btn {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                padding: 0.4375rem 0.5rem 0.4375rem 0.75rem;
                background: transparent;
                border: 0;
                color: inherit;
                font-family: var(--mono);
                font-size: 0.75rem;
                cursor: pointer;
                line-height: 1;
            }
            .ce-tab-btn:focus-visible {
                outline: 0;
                box-shadow: inset 0 0 0 1px var(--accent);
            }
            .ce-tab-name {
                max-width: 200px;
                overflow: hidden;
                text-overflow: ellipsis;
                font-variant-ligatures: none;
            }
            .ce-tab-rename {
                min-width: 120px;
                max-width: 220px;
                margin: 0 0.35rem;
                padding: 0.15rem 0.35rem;
                background: var(--bg);
                border: 1px solid var(--accent);
                border-radius: 3px;
                color: var(--ink);
                font-family: inherit;
                font-size: 12px;
                outline: none;
            }
            .ce-tab-fix {
                margin-left: 0.4rem;
                padding: 0.05rem 0.3rem;
                font-size: 0.625rem;
                font-weight: 600;
                letter-spacing: 0.02em;
                text-transform: uppercase;
                color: #c4b5fd;
                background: rgba(167, 139, 250, 0.14);
                border: 1px solid var(--accent);
                border-radius: 3px;
                line-height: 1.3;
            }
            .ce-tab-x {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                margin-right: 0.4375rem;
                background: transparent;
                border: 0;
                color: var(--ink-faint);
                cursor: pointer;
                opacity: 0;
                transition: opacity 0.1s, color 0.1s, background 0.1s;
            }
            .ce-tab:hover .ce-tab-x,
            .ce-tab.is-active .ce-tab-x { opacity: 0.7; }
            .ce-tab-x:hover { opacity: 1; color: var(--ink); background: var(--bg-hover); }
            .ce-tab-x svg { width: 11px; height: 11px; }

            /* ---------- Status dot in tabs ---------- */
            .ce-dot {
                width: 7px;
                height: 7px;
                border-radius: 0;
                background: currentColor;
                flex-shrink: 0;
                opacity: 0.55;
            }
            .ce-dot--pending { background: var(--ink-faint); opacity: 0.45; }
            .ce-dot--passed { background: var(--pass); opacity: 0.95; }
            .ce-dot--failed { background: var(--fail); opacity: 0.95; }
            .ce-dot--running {
                background: var(--run);
                animation: ce-blink 1s step-end infinite;
            }
            @keyframes ce-blink {
                50% { opacity: 0.25; }
            }

            .ce-spacer { flex: 1; min-width: 0.5rem; }

            /* ---------- Inline run summary ---------- */
            .ce-summary {
                display: flex;
                align-items: center;
                gap: 0.625rem;
                padding: 0 0.75rem;
                font-family: var(--mono);
                font-size: 0.6875rem;
                color: var(--ink-dim);
                font-variant-numeric: tabular-nums;
            }
            .ce-sum-passed { color: var(--pass); }
            .ce-sum-failed { color: var(--fail); }
            .ce-sum-running {
                display: inline-flex;
                align-items: center;
                gap: 0.375rem;
                color: var(--run);
                text-transform: lowercase;
                letter-spacing: 0.04em;
            }
            .ce-sum-spinner {
                width: 8px;
                height: 8px;
                border: 1px solid var(--run);
                border-top-color: transparent;
                border-radius: 50%;
                display: inline-block;
                animation: ce-spin 0.8s linear infinite;
            }

            .ce-rule {
                width: 1px;
                background: var(--hair);
                margin: 6px 0;
            }

            /* ---------- Icon actions ---------- */
            .ce-actions {
                display: flex;
                align-items: center;
                padding: 0 0.25rem;
                gap: 0;
            }
            .ce-icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                background: transparent;
                border: 0;
                color: var(--ink-dim);
                cursor: pointer;
                position: relative;
                margin: 3px 0;
                transition: background 0.1s, color 0.1s;
            }
            .ce-icon-btn:hover:not(:disabled) {
                background: var(--bg-hover);
                color: var(--ink);
            }
            .ce-icon-btn:focus-visible {
                outline: 0;
                box-shadow: inset 0 0 0 1px var(--accent);
                color: var(--ink);
            }
            .ce-icon-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            .ce-icon-btn svg {
                width: 14px;
                height: 14px;
            }
            .ce-icon-btn.is-success { color: var(--pass); }
            .ce-icon-btn.is-loading { color: var(--accent); }
            .ce-icon-btn--run { color: var(--accent); }
            .ce-icon-btn--run:hover:not(:disabled) {
                background: var(--accent-dim);
                color: var(--accent);
            }
            .ce-icon-btn--danger-active { color: var(--danger); background: rgba(215, 92, 92, 0.12); }

            .ce-spin { animation: ce-spin 1s linear infinite; transform-origin: center; }
            @keyframes ce-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            /* ---------- Delete confirm popover ---------- */
            .ce-confirm-anchor { position: relative; display: inline-flex; }
            .ce-confirm {
                position: absolute;
                top: calc(100% + 4px);
                right: 0;
                z-index: 200;
                background: #111;
                border: 1px solid var(--hair);
                padding: 0.625rem 0.75rem;
                min-width: 220px;
                font-family: var(--mono);
                font-size: 0.75rem;
                color: var(--ink);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
            }
            .ce-confirm p {
                margin: 0 0 0.125rem;
                font-size: 0.75rem;
            }
            .ce-mono {
                font-family: var(--mono);
                color: var(--accent);
            }
            .ce-confirm-hint {
                display: block;
                font-size: 0.6875rem;
                color: var(--ink-faint);
                margin-bottom: 0.625rem;
                line-height: 1.4;
            }
            .ce-confirm-row {
                display: flex;
                gap: 0.375rem;
                justify-content: flex-end;
            }
            .ce-confirm-btn {
                background: transparent;
                border: 1px solid var(--hair);
                color: var(--ink-dim);
                padding: 0.25rem 0.625rem;
                font-family: var(--mono);
                font-size: 0.6875rem;
                cursor: pointer;
                letter-spacing: 0.04em;
                transition: background 0.1s, color 0.1s, border-color 0.1s;
            }
            .ce-confirm-btn:hover { color: var(--ink); border-color: #2a2a2a; background: var(--bg-hover); }
            .ce-confirm-btn--danger { color: var(--danger); border-color: rgba(215, 92, 92, 0.4); }
            .ce-confirm-btn--danger:hover {
                background: rgba(215, 92, 92, 0.12);
                color: #ff8888;
                border-color: var(--danger);
            }

            /* ---------- AI-fix diff review ---------- */
            .ce-bar--diff {
                align-items: center;
                padding-left: 0.75rem;
            }
            .ce-diff-title {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                min-width: 0;
                font-family: var(--mono);
                font-size: 0.75rem;
                color: var(--ink);
            }
            .ce-diff-badge {
                font-size: 0.625rem;
                letter-spacing: 0.06em;
                text-transform: uppercase;
                color: var(--accent);
                border: 1px solid var(--accent-dim);
                background: var(--accent-dim);
                padding: 0.125rem 0.375rem;
                border-radius: 2px;
            }
            .ce-diff-meta {
                font-size: 0.6875rem;
                color: var(--ink-faint);
                font-variant-numeric: tabular-nums;
            }
            .ce-diff-actions { gap: 0.375rem; padding: 0 0.5rem; }
            .ce-diff-btn {
                font-family: var(--mono);
                font-size: 0.6875rem;
                letter-spacing: 0.03em;
                padding: 0.3125rem 0.75rem;
                border: 1px solid var(--hair);
                background: transparent;
                color: var(--ink-dim);
                cursor: pointer;
                transition: background 0.1s, color 0.1s, border-color 0.1s;
            }
            .ce-diff-btn--reject:hover { color: var(--ink); border-color: #2a2a2a; background: var(--bg-hover); }
            .ce-diff-btn--apply {
                color: var(--accent);
                border-color: var(--accent-dim);
                background: var(--accent-dim);
            }
            .ce-diff-btn--apply:hover { color: #c4b5fd; border-color: var(--accent); }
            .ce-diff-warn {
                flex-shrink: 0;
                padding: 0.5rem 0.75rem;
                background: rgba(215, 92, 92, 0.1);
                border-bottom: 1px solid rgba(215, 92, 92, 0.3);
                color: #e69a9a;
                font-family: var(--mono);
                font-size: 0.6875rem;
                line-height: 1.5;
            }

            /* ---------- Editor area ---------- */
            .ce-editor {
                flex: 1;
                position: relative;
                min-height: 200px;
            }
            .ce-loading {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 0.625rem;
                background: var(--bg);
                color: var(--ink-faint);
                font-family: var(--mono);
                font-size: 0.75rem;
                z-index: 10;
                letter-spacing: 0.04em;
            }
            .ce-loading-spin {
                width: 10px;
                height: 10px;
                border: 1px solid var(--accent);
                border-top-color: transparent;
                border-radius: 50%;
                animation: ce-spin 0.8s linear infinite;
            }

            /* ---------- Empty state ---------- */
            .ce-empty {
                flex: 1;
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                justify-content: center;
                gap: 0.5rem;
                padding: 2rem 2.5rem;
                background: var(--bg);
                font-family: var(--mono);
            }
            .ce-empty-prompt {
                margin: 0;
                font-family: var(--mono);
                font-size: 0.8125rem;
                color: var(--ink-faint);
                white-space: pre;
            }
            .ce-empty-hint {
                margin: 0;
                font-family: var(--mono);
                font-size: 0.75rem;
                color: var(--ink-dim);
                line-height: 1.6;
            }
            .ce-empty-link {
                background: transparent;
                border: 0;
                padding: 0;
                color: var(--accent);
                font: inherit;
                cursor: pointer;
                text-decoration: underline;
                text-decoration-thickness: 1px;
                text-underline-offset: 3px;
            }
            .ce-empty-link:hover { text-decoration-thickness: 2px; }
        `}</style>
    );
}
