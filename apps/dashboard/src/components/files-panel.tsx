export interface TestFileItem {
  id: string;
  name: string;
  path: string;
  directory: string;
  status: 'fresh' | 'stale' | 'broken';
}

interface FilesPanelProps {
  files: TestFileItem[];
  activeFilePath?: string;
  onFileSelect?: (filePath: string) => void;
}

export function FilesPanel({ files, activeFilePath, onFileSelect }: FilesPanelProps) {
  const getStatusIcon = (status: TestFileItem['status']) => {
    switch (status) {
      case 'fresh':
        return (
          <svg className="status-icon fresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 13l4 4L19 7" />
          </svg>
        );
      case 'stale':
        return (
          <svg className="status-icon stale" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        );
      case 'broken':
        return (
          <svg className="status-icon broken" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        );
    }
  };

  // Empty state if no test files
  if (files.length === 0) {
    return (
      <div className="files-panel">
        {/* Header */}
        <div className="files-header">
          <svg className="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <div className="header-info">
            <span className="header-title">Test Files</span>
            <span className="header-subtitle">No test files yet</span>
          </div>
        </div>

        {/* Empty State */}
        <div className="empty-state">
          <svg className="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3 className="empty-title">No test files yet</h3>
          <p className="empty-text">Use the AI chat to generate your first test</p>
        </div>

        <style>{`
          .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 1rem;
            padding: 2rem 1rem;
            text-align: center;
          }

          .empty-icon {
            width: 4rem;
            height: 4rem;
            color: #6b7280;
          }

          .empty-title {
            margin: 0;
            font-size: 1rem;
            font-weight: 500;
            color: #9ca3af;
          }

          .empty-text {
            margin: 0;
            font-size: 0.875rem;
            color: #6b7280;
          }
        `}</style>
      </div>
    );
  }

  // Group files by directory
  const groupedFiles = files.reduce((acc, file) => {
    if (!acc[file.directory]) {
      acc[file.directory] = [];
    }
    acc[file.directory].push(file);
    return acc;
  }, {} as Record<string, TestFileItem[]>);

  const statusCounts = {
    fresh: files.filter(f => f.status === 'fresh').length,
    stale: files.filter(f => f.status === 'stale').length,
    broken: files.filter(f => f.status === 'broken').length,
  };

  return (
    <div className="files-panel">
      {/* Header */}
      <div className="files-header">
        <svg className="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <div className="header-info">
          <span className="header-title">Test Files</span>
          <span className="header-subtitle">{files.length} test files</span>
        </div>
      </div>

      {/* File List */}
      <div className="files-list">
        {Object.entries(groupedFiles).map(([directory, dirFiles]) => (
          <div key={directory} className="directory-group">
            <div className="directory-header">
              <svg className="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span>{directory}</span>
            </div>
            
            {dirFiles.map((file) => (
              <button
                type="button"
                key={file.path}
                className={`file-item ${file.status} ${activeFilePath === file.path ? 'active' : ''}`}
                onClick={() => onFileSelect?.(file.path)}
              >
                <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="file-name">{file.name}</span>
                {getStatusIcon(file.status)}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <span className="status-count fresh">
          <span className="dot" />
          {statusCounts.fresh} Fresh
        </span>
        <span className="status-count stale">
          <span className="dot" />
          {statusCounts.stale} Stale
        </span>
        <span className="status-count broken">
          <span className="dot" />
          {statusCounts.broken} Broken
        </span>
      </div>

      <style>{`
        .files-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 1rem;
          gap: 1rem;
          overflow: hidden;
          background: linear-gradient(180deg, rgba(88, 28, 135, 0.2) 0%, rgba(15, 15, 15, 0) 50%);
        }

        .files-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid #1f1f1f;
        }

        .header-icon {
          width: 1.75rem;
          height: 1.75rem;
          color: #a855f7;
        }

        .header-info {
          display: flex;
          flex-direction: column;
        }

        .header-title {
          font-size: 0.9375rem;
          font-weight: 600;
          color: #e5e7eb;
        }

        .header-subtitle {
          font-size: 0.75rem;
          color: #6b7280;
        }

        .files-list {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          overflow-y: auto;
        }

        .directory-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .directory-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.75rem;
          color: #6b7280;
        }

        .folder-icon {
          width: 1rem;
          height: 1rem;
        }

        .file-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.5rem 1rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 8px;
          cursor: pointer;
          text-align: left;
          transition: all 0.15s;
        }

        .file-item.fresh {
          background: rgba(34, 197, 94, 0.1);
          border-color: rgba(34, 197, 94, 0.2);
        }

        .file-item.fresh:hover {
          background: rgba(34, 197, 94, 0.15);
        }

        .file-item.stale {
          background: rgba(168, 85, 247, 0.1);
          border-color: #a855f7;
        }

        .file-item.stale:hover {
          background: rgba(168, 85, 247, 0.15);
        }

        .file-item.broken {
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.2);
        }

        .file-item.broken:hover {
          background: rgba(239, 68, 68, 0.15);
        }

        .file-icon {
          width: 1.125rem;
          height: 1.125rem;
          color: #9ca3af;
          flex-shrink: 0;
        }

        .file-name {
          flex: 1;
          font-size: 0.875rem;
          color: #e5e7eb;
        }

        .status-icon {
          width: 1.125rem;
          height: 1.125rem;
          flex-shrink: 0;
        }

        .status-icon.fresh {
          color: #22c55e;
        }

        .status-icon.stale {
          color: #a855f7;
        }

        .status-icon.broken {
          color: #ef4444;
        }

        .status-bar {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding-top: 1rem;
          border-top: 1px solid #1f1f1f;
        }

        .status-count {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
        }

        .status-count .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-count.fresh {
          color: #22c55e;
        }

        .status-count.fresh .dot {
          background: #22c55e;
        }

        .status-count.stale {
          color: #eab308;
        }

        .status-count.stale .dot {
          background: #eab308;
        }

        .status-count.broken {
          color: #ef4444;
        }

        .status-count.broken .dot {
          background: #ef4444;
        }
      `}</style>
    </div>
  );
}

