import Editor from "@monaco-editor/react";
import { EditorLoadingOverlay } from "./editor-empty-state";
import { defineRaikenTheme, getLanguage, monacoEditorOptions } from "./monaco-config";

export function MonacoEditorPane({
    fileName,
    content,
    isReady,
    onReady,
    onChange,
}: {
    fileName: string;
    content: string;
    isReady: boolean;
    onReady: () => void;
    onChange: (value: string | undefined) => void;
}) {
    return (
        <div className="ce-editor">
            {!isReady && <EditorLoadingOverlay label="loading editor" />}
            <Editor
                height="100%"
                language={getLanguage(fileName)}
                value={content || ""}
                theme="vs-dark"
                beforeMount={defineRaikenTheme}
                onMount={(_editor, monaco) => {
                    monaco.editor.setTheme("raiken-dark");
                    onReady();
                }}
                onChange={onChange}
                options={monacoEditorOptions}
            />
        </div>
    );
}
