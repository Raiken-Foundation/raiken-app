import type { Monaco } from "@monaco-editor/react";

export function defineRaikenTheme(monaco: Monaco) {
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

export function getLanguage(filename: string): string {
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

const MONACO_FONT = "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace";

export const monacoScrollbarOptions = {
    vertical: "auto" as const,
    horizontal: "auto" as const,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
};

export const monacoEditorOptions = {
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 22,
    fontFamily: MONACO_FONT,
    fontLigatures: true,
    padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false,
    lineNumbers: "on" as const,
    renderLineHighlight: "line" as const,
    cursorStyle: "line" as const,
    automaticLayout: true,
    scrollbar: monacoScrollbarOptions,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    glyphMargin: false,
    folding: true,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 4,
};

export const monacoDiffEditorOptions = {
    renderSideBySide: true,
    readOnly: false,
    originalEditable: false,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 22,
    fontFamily: MONACO_FONT,
    fontLigatures: true,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderOverviewRuler: false,
    scrollbar: monacoScrollbarOptions,
};
