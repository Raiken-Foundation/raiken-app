import { useState } from 'react';
import Editor from '@monaco-editor/react';

export interface TestFile {
  id: string;
  name: string;
  path: string;
  content: string;
  status: 'passed' | 'failed' | 'running' | 'pending';
  passedCount?: number;
  failedCount?: number;
  language?: string;
}

interface CodeEditorProps {
  files: TestFile[];
  activeFileId: string;
  onFileSelect: (fileId: string) => void;
  onContentChange?: (fileId: string, content: string) => void;
}

export function CodeEditor({ files, activeFileId, onFileSelect, onContentChange }: CodeEditorProps) {
  const activeFile = files.find(f => f.id === activeFileId);
  const [isEditorReady, setIsEditorReady] = useState(false);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && onContentChange) {
      onContentChange(activeFileId, value);
    }
  };

  const getStatusIcon = (status: TestFile['status']) => {
    switch (status) {
      case 'passed':
        return (
          <svg className="tab-status passed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 13l4 4L19 7" />
          </svg>
        );
      case 'failed':
        return (
          <svg className="tab-status failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
      case 'running':
        return (
          <svg className="tab-status running" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        );
      default:
        return null;
    }
  };

  // Get language from file extension
  const getLanguage = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'json': 'json',
      'css': 'css',
      'scss': 'scss',
      'html': 'html',
      'md': 'markdown',
    };
    return langMap[ext || ''] || 'typescript';
  };

  return (
    <div className="code-editor">
      {/* Tabs */}
      <div className="editor-tabs">
        {files.map((file) => (
          <button
            key={file.id}
            className={`editor-tab ${file.id === activeFileId ? 'active' : ''}`}
            onClick={() => onFileSelect(file.id)}
          >
            <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{file.name}</span>
            {getStatusIcon(file.status)}
          </button>
        ))}
      </div>

      {/* File Header */}
      {activeFile && (
        <div className="file-header">
          <div className="file-path">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{activeFile.path}</span>
          </div>
          <div className={`status-badge ${activeFile.status}`}>
            {activeFile.status === 'failed' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
                Tests failed
              </>
            )}
            {activeFile.status === 'passed' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 13l4 4L19 7" />
                </svg>
                Tests passed
              </>
            )}
            {activeFile.status === 'running' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Running...
              </>
            )}
          </div>
        </div>
      )}

      {/* Monaco Editor */}
      <div className="editor-container">
        {!isEditorReady && (
          <div className="editor-loading">
            <div className="loading-spinner" />
            <span>Loading editor...</span>
          </div>
        )}
        <Editor
          height="100%"
          language={activeFile ? getLanguage(activeFile.name) : 'typescript'}
          value={activeFile?.content || ''}
          theme="vs-dark"
          beforeMount={(monaco) => {
            // Define custom black theme
            monaco.editor.defineTheme('raiken-dark', {
              base: 'vs-dark',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#0a0a0a',
                'editor.lineHighlightBackground': '#1a1a1a',
                'editorLineNumber.foreground': '#4b5563',
                'editorLineNumber.activeForeground': '#9ca3af',
                'editor.selectionBackground': '#264f78',
                'editorCursor.foreground': '#3b82f6',
              }
            });
          }}
          onMount={(editor, monaco) => {
            monaco.editor.setTheme('raiken-dark');
            setIsEditorReady(true);
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 22,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
            fontLigatures: true,
            padding: { top: 16, bottom: 16 },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            cursorStyle: 'line',
            automaticLayout: true,
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
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

      {/* Results Bar */}
      {activeFile && (
        <div className="results-bar">
          {activeFile.failedCount !== undefined && activeFile.failedCount > 0 && (
            <span className="result-count failed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
              {activeFile.failedCount} failed
            </span>
          )}
          {activeFile.passedCount !== undefined && (
            <span className="result-count passed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 13l4 4L19 7" />
              </svg>
              {activeFile.passedCount} passed
            </span>
          )}
          <span className="result-time">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            1.323s
          </span>
        </div>
      )}

      <style>{`
        .code-editor {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: #0a0a0a;
          overflow: hidden;
          min-height: 0;
        }

        .editor-tabs {
          display: flex;
          align-items: center;
          gap: 0;
          background: #0f0f0f;
          border-bottom: 1px solid #1f1f1f;
          overflow-x: auto;
          flex-shrink: 0;
        }

        .editor-tab {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: #6b7280;
          font-size: 0.8125rem;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }

        .editor-tab:hover {
          background: #1a1a1a;
          color: #9ca3af;
        }

        .editor-tab.active {
          background: #0a0a0a;
          color: #e5e7eb;
          border-bottom-color: #3b82f6;
        }

        .file-icon {
          width: 1rem;
          height: 1rem;
        }

        .tab-status {
          width: 0.875rem;
          height: 0.875rem;
        }

        .tab-status.passed {
          color: #22c55e;
        }

        .tab-status.failed {
          color: #ef4444;
        }

        .tab-status.running {
          color: #60a5fa;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .file-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          background: #0f0f0f;
          border-bottom: 1px solid #1f1f1f;
          flex-shrink: 0;
        }

        .file-path {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: #6b7280;
          font-size: 0.8125rem;
        }

        .file-path svg {
          width: 1rem;
          height: 1rem;
        }

        .status-badge {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.75rem;
          border-radius: 6px;
          font-size: 0.75rem;
          font-weight: 500;
        }

        .status-badge.failed {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.2);
        }

        .status-badge.passed {
          background: rgba(34, 197, 94, 0.1);
          color: #22c55e;
          border: 1px solid rgba(34, 197, 94, 0.2);
        }

        .status-badge.running {
          background: rgba(96, 165, 250, 0.1);
          color: #60a5fa;
          border: 1px solid rgba(96, 165, 250, 0.2);
        }

        .status-badge svg {
          width: 0.75rem;
          height: 0.75rem;
        }

        .editor-container {
          flex: 1;
          position: relative;
          min-height: 200px;
        }

        .editor-loading {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          background: #0a0a0a;
          color: #6b7280;
          font-size: 0.875rem;
          z-index: 10;
        }

        .loading-spinner {
          width: 24px;
          height: 24px;
          border: 2px solid #3f3f46;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        .results-bar {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 0.625rem 1rem;
          background: #0f0f0f;
          border-top: 1px solid #1f1f1f;
          flex-shrink: 0;
        }

        .result-count {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.8125rem;
        }

        .result-count svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .result-count.failed {
          color: #ef4444;
        }

        .result-count.passed {
          color: #22c55e;
        }

        .result-time {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          color: #6b7280;
          font-size: 0.8125rem;
          margin-left: auto;
        }

        .result-time svg {
          width: 0.875rem;
          height: 0.875rem;
        }
      `}</style>
    </div>
  );
}
