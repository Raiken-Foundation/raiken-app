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

export interface CodeEditorProps {
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
