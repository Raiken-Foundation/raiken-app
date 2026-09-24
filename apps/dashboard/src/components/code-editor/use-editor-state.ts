import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffReview } from "./types";

export function useEditorState(options: {
    activeFileId: string;
    savedFileId?: string | null;
    diffReview?: DiffReview | null;
    onSaveFile?: (fileId: string) => void;
    onRunTests?: (fileId: string) => void;
    onRenameFile?: (fileId: string, newName: string) => void;
    isRunningTests?: boolean;
}) {
    const {
        activeFileId,
        savedFileId,
        diffReview,
        onSaveFile,
        onRunTests,
        onRenameFile,
        isRunningTests,
    } = options;

    const [isEditorReady, setIsEditorReady] = useState(false);
    const [showSavedFlash, setShowSavedFlash] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const confirmRef = useRef<HTMLDivElement | null>(null);

    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const renameActiveRef = useRef(false);

    const [isDiffReady, setIsDiffReady] = useState(false);
    const diffModifiedRef = useRef("");

    const startRename = useCallback((id: string, name: string) => {
        renameActiveRef.current = true;
        setRenamingId(id);
        setRenameValue(name);
    }, []);

    const commitRename = useCallback(
        (id: string, currentName: string) => {
            if (!renameActiveRef.current) return;
            renameActiveRef.current = false;
            setRenamingId(null);
            const v = renameValue.trim();
            if (v && v !== currentName) onRenameFile?.(id, v);
        },
        [onRenameFile, renameValue],
    );

    const cancelRename = useCallback(() => {
        renameActiveRef.current = false;
        setRenamingId(null);
    }, []);

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

    return {
        isEditorReady,
        setIsEditorReady,
        showSavedFlash,
        confirmDelete,
        setConfirmDelete,
        confirmRef,
        renamingId,
        renameValue,
        setRenameValue,
        startRename,
        commitRename,
        cancelRename,
        isDiffReady,
        setIsDiffReady,
        diffModifiedRef,
    };
}
