import { DiffEditor } from "@monaco-editor/react";
import { EditorLoadingOverlay } from "./editor-empty-state";
import { defineRaikenTheme, getLanguage, monacoDiffEditorOptions } from "./monaco-config";
import type { DiffReview } from "./types";

export function MonacoDiffPane({
    diffReview,
    isReady,
    diffModifiedRef,
    onReady,
}: {
    diffReview: DiffReview;
    isReady: boolean;
    diffModifiedRef: React.MutableRefObject<string>;
    onReady: () => void;
}) {
    return (
        <div className="ce-editor">
            {!isReady && <EditorLoadingOverlay label="loading diff" />}
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
                    onReady();
                }}
                options={monacoDiffEditorOptions}
            />
        </div>
    );
}

export function DiffMatchFailedBanner() {
    return (
        <div className="ce-diff-warn" role="alert">
            Some section edits couldn&apos;t be matched to the current file, so this is a full
            rewrite — review carefully before applying.
        </div>
    );
}
