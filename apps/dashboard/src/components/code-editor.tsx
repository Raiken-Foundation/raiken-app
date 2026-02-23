import { useState, useEffect, useCallback } from 'react';
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
  onFileClose?: (fileId: string) => void;
  onContentChange?: (fileId: string, content: string) => void;
  onRunTests?: (fileId: string) => void;
  onNewFile?: () => void;
  onSaveFile?: (fileId: string) => void;
  onDeleteFile?: (fileId: string) => void;
  isRunningTests?: boolean;
  isSaving?: boolean;
  savedFileId?: string | null;
}

export function CodeEditor({ files, activeFileId, onFileSelect, onFileClose, onContentChange, onRunTests, onNewFile, onSaveFile, onDeleteFile, isRunningTests, isSaving, savedFileId }: CodeEditorProps) {
  const activeFile = files.find(f => f.id === activeFileId);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [showSavedFlash, setShowSavedFlash] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (savedFileId === activeFileId && savedFileId) {
      setShowSavedFlash(true);
      const t = setTimeout(() => setShowSavedFlash(false), 1800);
      return () => clearTimeout(t);
    }
  }, [savedFileId, activeFileId]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (onSaveFile && activeFileId) onSaveFile(activeFileId);
    }
  }, [onSaveFile, activeFileId]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && onContentChange) {
      onContentChange(activeFileId, value);
    }
  };

  // Empty state when no file is selected
  if (!activeFile) {
    return (
      <div className="code-editor">
        <div className="empty-state">
          <svg className="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3>No file selected</h3>
          <p>Select a test file from the sidebar or create a new one</p>
          {onNewFile && (
            <button type="button" className="new-file-btn" onClick={onNewFile}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New File
            </button>
          )}
        </div>
        <style>{`
          .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 1.5rem;
            padding: 3rem 2rem;
            text-align: center;
            background: #0a0a0a;
          }

          .empty-icon {
            width: 5rem;
            height: 5rem;
            color: #4b5563;
          }

          .empty-state h3 {
            margin: 0;
            font-size: 1.25rem;
            font-weight: 500;
            color: #9ca3af;
          }

          .empty-state p {
            margin: 0;
            font-size: 0.9375rem;
            color: #6b7280;
          }

          .empty-state .new-file-btn {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.625rem 1.25rem;
            background: #2563eb;
            border: none;
            border-radius: 0.5rem;
            color: white;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
          }

          .empty-state .new-file-btn:hover {
            background: #1d4ed8;
          }

          .empty-state .new-file-btn svg {
            width: 1rem;
            height: 1rem;
          }
        `}</style>
      </div>
    );
  }

  const getStatusIcon = (status: TestFile['status']) => {
    switch (status) {
      case 'passed':
        return (
          <svg className="tab-status passed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 13l4 4L19 7" />
          </svg>
        );
      case 'failed':
        return (
          <svg className="tab-status failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
      case 'running':
        return (
          <svg className="tab-status running" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
          <div
            key={file.id}
            className={`editor-tab ${file.id === activeFileId ? 'active' : ''}`}
          >
            <button
              className="tab-content"
            onClick={() => onFileSelect(file.id)}
          >
            <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
              <span className="tab-name">{file.name}</span>
            {getStatusIcon(file.status)}
          </button>
            {onFileClose && (
              <button
                type="button"
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClose(file.id);
                }}
                title="Close file"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* File Header */}
      {activeFile && (
        <div className="file-header">
          <div className="file-path">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{activeFile.path}</span>
          </div>
          <div className="header-actions">
            {onNewFile && (
              <button
                type="button"
                className="new-file-header-btn"
                onClick={onNewFile}
                title="Create new file"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New
              </button>
            )}
            {onSaveFile && (
              <button
                type="button"
                className={`save-file-btn ${showSavedFlash ? 'saved' : ''}`}
                onClick={() => onSaveFile(activeFileId)}
                disabled={isSaving}
                title="Save file (⌘S)"
              >
                {isSaving ? (
                  <>
                    <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Saving…
                  </>
                ) : showSavedFlash ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    Saved
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                    Save
                  </>
                )}
              </button>
            )}
            {onDeleteFile && (
              <>
                <button
                  type="button"
                  className="delete-file-btn"
                  onClick={() => setShowDeleteConfirm(true)}
                  title="Delete file"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                {showDeleteConfirm && (
                  <div className="delete-confirm-popover">
                    <p>Delete <strong>{activeFile?.name}</strong>?</p>
                    <span className="delete-confirm-hint">This will remove the file from disk.</span>
                    <div className="delete-confirm-actions">
                      <button type="button" className="dc-cancel" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                      <button type="button" className="dc-delete" onClick={() => { setShowDeleteConfirm(false); onDeleteFile(activeFileId); }}>Delete</button>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="header-divider" />
            {onRunTests && (
              <button
                type="button"
                className={`run-tests-btn ${isRunningTests ? 'running' : ''}`}
                onClick={() => onRunTests(activeFile.id)}
                disabled={isRunningTests}
                title="Run tests in this file"
              >
                {isRunningTests ? (
                  <>
                    <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Running...
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Run Tests
                  </>
                )}
              </button>
            )}
          <div className={`status-badge ${activeFile.status}`}>
            {activeFile.status === 'failed' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
                Tests failed
              </>
            )}
            {activeFile.status === 'passed' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" />
                </svg>
                Tests passed
              </>
            )}
            {activeFile.status === 'running' && (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Running...
              </>
            )}
            </div>
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
          onMount={(_editor, monaco) => {
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
              {activeFile.failedCount} failed
            </span>
          )}
          {activeFile.passedCount !== undefined && (
            <span className="result-count passed">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 13l4 4L19 7" />
              </svg>
              {activeFile.passedCount} passed
            </span>
          )}
          <span className="result-time">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
          gap: 0;
          padding: 0;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: #6b7280;
          font-size: 0.8125rem;
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

        .tab-content {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 0.75rem;
          background: transparent;
          border: none;
          color: inherit;
          font-size: inherit;
          cursor: pointer;
        }

        .tab-name {
          max-width: 150px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tab-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.25rem;
          height: 1.25rem;
          margin-right: 0.5rem;
          background: transparent;
          border: none;
          border-radius: 4px;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
          opacity: 0;
        }

        .editor-tab:hover .tab-close,
        .editor-tab.active .tab-close {
          opacity: 1;
        }

        .tab-close:hover {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .tab-close svg {
          width: 0.75rem;
          height: 0.75rem;
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

        .header-actions {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .new-file-header-btn {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.75rem;
          background: transparent;
          border: 1px solid #3a3a3a;
          border-radius: 0.375rem;
          color: #9ca3af;
          font-size: 0.75rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .new-file-header-btn:hover {
          background: #1f1f1f;
          border-color: #4a4a4a;
          color: #e5e7eb;
        }

        .new-file-header-btn svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .run-tests-btn {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
          border: none;
          border-radius: 6px;
          color: white;
          font-size: 0.8125rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
          box-shadow: 0 2px 8px rgba(34, 197, 94, 0.25);
        }

        .run-tests-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(34, 197, 94, 0.35);
        }

        .run-tests-btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .run-tests-btn.running {
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
          box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
        }

        .run-tests-btn svg {
          width: 1rem;
          height: 1rem;
        }

        .run-tests-btn .spin {
          animation: spin 1s linear infinite;
        }

        .header-divider {
          width: 1px;
          height: 1.25rem;
          background: #2a2a2a;
        }

        .save-file-btn {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.75rem;
          background: transparent;
          border: 1px solid #3a3a3a;
          border-radius: 0.375rem;
          color: #9ca3af;
          font-size: 0.75rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .save-file-btn:hover:not(:disabled) {
          background: #1f1f1f;
          border-color: #4a4a4a;
          color: #e5e7eb;
        }

        .save-file-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .save-file-btn.saved {
          border-color: rgba(34, 197, 94, 0.4);
          color: #22c55e;
        }

        .save-file-btn svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .save-file-btn .spin {
          animation: spin 1s linear infinite;
        }

        .delete-file-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0.375rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 0.375rem;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
          position: relative;
        }

        .delete-file-btn:hover {
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.3);
          color: #ef4444;
        }

        .delete-file-btn svg {
          width: 0.9375rem;
          height: 0.9375rem;
        }

        .delete-confirm-popover {
          position: absolute;
          top: calc(100% + 0.5rem);
          right: 0;
          z-index: 200;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
          min-width: 220px;
        }

        .delete-confirm-popover p {
          margin: 0 0 0.25rem 0;
          font-size: 0.8125rem;
          color: #e5e7eb;
        }

        .delete-confirm-hint {
          display: block;
          font-size: 0.6875rem;
          color: #6b7280;
          margin-bottom: 0.75rem;
        }

        .delete-confirm-actions {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
        }

        .dc-cancel, .dc-delete {
          padding: 0.3125rem 0.75rem;
          border: none;
          border-radius: 0.375rem;
          font-size: 0.75rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .dc-cancel {
          background: #2a2a2a;
          color: #e5e7eb;
        }

        .dc-cancel:hover {
          background: #3a3a3a;
        }

        .dc-delete {
          background: #dc2626;
          color: white;
        }

        .dc-delete:hover {
          background: #b91c1c;
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
