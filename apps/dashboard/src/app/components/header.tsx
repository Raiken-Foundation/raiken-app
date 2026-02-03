

interface HeaderProps {
  projectName: string;
  staleCount?: number;
  failedCount?: number;
  userName?: string;
  onMonitorSync?: () => void;
}

export function Header({ 
  projectName, 
  staleCount = 0, 
  failedCount = 0, 
  userName = 'User',
  onMonitorSync 
}: HeaderProps) {
  return (
    <header className="header">
      {/* Left Section - Logo & Project */}
      <div className="header-left">
        <div className="logo">
          <svg className="logo-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path 
              d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" 
              stroke="currentColor" 
              strokeWidth="1.5" 
              strokeLinejoin="round"
            />
            <path d="M5 19l1 3 3-1-1-3-3 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M19 19l-1 3-3-1 1-3 3 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
          <span className="logo-text">Raiken</span>
        </div>
        
        <div className="divider" />
        
        <button type="button" className="project-selector">
          <svg className="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span>{projectName}</span>
        </button>
      </div>

      {/* Center Section - Status & Actions */}
      <div className="header-center">
        <div className="status-pills">
          {staleCount > 0 && (
            <span className="status-pill stale">
              <span className="pill-dot" />
              {staleCount} Stale
            </span>
          )}
          {failedCount > 0 && (
            <span className="status-pill failed">
              <svg className="warning-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {failedCount} Failed
            </span>
          )}
          <button type="button" className="monitor-sync-btn" onClick={onMonitorSync}>
            <svg className="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Monitor & Sync
          </button>
        </div>
      </div>

      {/* Right Section - User */}
      <div className="header-right">
        <div className="user-info">
          <div className="user-avatar">
            {userName.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </div>
          <span className="user-name">{userName}</span>
          <svg className="dropdown-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      <style>{`
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          background: #0f0f0f;
          border-bottom: 1px solid #1f1f1f;
          height: 56px;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .logo {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .logo-icon {
          width: 1.5rem;
          height: 1.5rem;
          color: #3b82f6;
        }

        .logo-text {
          font-size: 1.125rem;
          font-weight: 600;
          color: #ffffff;
        }

        .divider {
          width: 1px;
          height: 1.5rem;
          background: #2a2a2a;
        }

        .project-selector {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.375rem 0.75rem;
          background: transparent;
          border: none;
          color: #9ca3af;
          font-size: 0.875rem;
          cursor: pointer;
          border-radius: 0.375rem;
          transition: all 0.15s;
        }

        .project-selector:hover {
          background: #1f1f1f;
          color: #e5e7eb;
        }

        .folder-icon {
          width: 1rem;
          height: 1rem;
        }

        .header-center {
          display: flex;
          align-items: center;
        }

        .status-pills {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.25rem;
          background: #1a1a1a;
          border-radius: 9999px;
        }

        .status-pill {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.75rem;
          font-size: 0.8125rem;
          font-weight: 500;
          border-radius: 9999px;
        }

        .status-pill.stale {
          color: #fbbf24;
        }

        .status-pill.failed {
          color: #f87171;
        }

        .pill-dot {
          width: 0.5rem;
          height: 0.5rem;
          background: #fbbf24;
          border-radius: 50%;
        }

        .warning-icon {
          width: 1rem;
          height: 1rem;
        }

        .monitor-sync-btn {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.875rem;
          background: transparent;
          border: 1px solid #22c55e;
          color: #22c55e;
          font-size: 0.8125rem;
          font-weight: 500;
          border-radius: 9999px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .monitor-sync-btn:hover {
          background: rgba(34, 197, 94, 0.1);
        }

        .sync-icon {
          width: 1rem;
          height: 1rem;
        }

        .header-right {
          display: flex;
          align-items: center;
        }

        .user-info {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.25rem;
          cursor: pointer;
          border-radius: 0.5rem;
          transition: all 0.15s;
        }

        .user-info:hover {
          background: #1f1f1f;
        }

        .user-avatar {
          width: 2rem;
          height: 2rem;
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          font-weight: 600;
          color: white;
        }

        .user-name {
          font-size: 0.875rem;
          color: #e5e7eb;
          font-weight: 500;
        }

        .dropdown-icon {
          width: 1rem;
          height: 1rem;
          color: #6b7280;
        }
      `}</style>
    </header>
  );
}

