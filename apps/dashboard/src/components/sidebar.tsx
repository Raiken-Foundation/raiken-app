import { useState } from 'react';
import { FilesPanel, TestFileItem } from './files-panel';

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isUser: boolean;
}

interface SidebarProps {
  onSendMessage?: (message: string) => void;
  onFileSelect?: (fileId: string) => void;
  activeFileId?: string;
}

// Sample files data
const sampleFiles: TestFileItem[] = [
  {
    id: '1',
    name: 'UserProfile.test.tsx',
    path: 'src/components/UserProfile.test.tsx',
    directory: 'src/components',
    status: 'fresh',
  },
  {
    id: '2',
    name: 'AuthService.test.tsx',
    path: 'src/services/AuthService.test.tsx',
    directory: 'src/services',
    status: 'stale',
  },
  {
    id: '3',
    name: 'Dashboard.test.tsx',
    path: 'src/pages/Dashboard.test.tsx',
    directory: 'src/pages',
    status: 'broken',
  },
];

export function Sidebar({ onSendMessage, onFileSelect, activeFileId }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'files' | 'settings'>('chat');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'Test',
      timestamp: '07:04 PM',
      isUser: true
    }
  ]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    
    const newMessage: Message = {
      id: Date.now().toString(),
      content: inputValue,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      isUser: true
    };
    
    setMessages([...messages, newMessage]);
    onSendMessage?.(inputValue);
    setInputValue('');
  };

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Navigation Icons */}
      <nav className="sidebar-nav">
        <button 
          className={`nav-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => { setActiveTab('chat'); if (isCollapsed) setIsCollapsed(false); }}
        >
          {/* Rounded rectangle chat bubble */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="4" y="4" width="16" height="14" rx="3" />
            <path d="M8 9h8M8 13h5" />
          </svg>
        </button>
        <button 
          className={`nav-btn ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => { setActiveTab('files'); if (isCollapsed) setIsCollapsed(false); }}
        >
          {/* Folder icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </button>
        <button 
          className={`nav-btn settings ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => { setActiveTab('settings'); if (isCollapsed) setIsCollapsed(false); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Collapse Toggle */}
        <button 
          className="nav-btn collapse-btn"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d={isCollapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
          </svg>
        </button>
      </nav>

      {/* Content Panels - Hidden when collapsed */}
      {!isCollapsed && (
        <>
          {/* Chat Panel */}
          {activeTab === 'chat' && (
            <div className="chat-panel">
              {/* AI Agent Header */}
              <div className="agent-header">
                <div className="agent-icon">
                  <svg viewBox="5 2 14 14" fill="none">
                    <path 
                      d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" 
                      stroke="currentColor" 
                      strokeWidth="1.5" 
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="agent-info">
                  <span className="agent-title">AI Agent</span>
                  <span className="agent-status">
                    <span className="status-dot" />
                    Ready
                  </span>
                </div>
              </div>

              {/* Messages */}
              <div className="messages">
                {messages.map((msg) => (
                  <div key={msg.id} className={`message ${msg.isUser ? 'user' : 'assistant'}`}>
                    <div className="message-bubble">
                      {msg.content}
                    </div>
                    <span className="message-time">{msg.timestamp}</span>
                  </div>
                ))}
              </div>

              {/* Input */}
              <form className="chat-input-container" onSubmit={handleSubmit}>
                <input
                  type="text"
                  className="chat-input"
                  placeholder="Refine the tests..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                />
                <button type="submit" className="send-btn">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              </form>
            </div>
          )}

          {/* Files Panel */}
          {activeTab === 'files' && (
            <FilesPanel 
              files={sampleFiles}
              activeFileId={activeFileId}
              onFileSelect={onFileSelect}
            />
          )}

          {/* Settings Panel */}
          {activeTab === 'settings' && (
            <div className="settings-panel">
              <span className="settings-title">Settings</span>
              <span className="settings-subtitle">Coming soon...</span>
            </div>
          )}
        </>
      )}

      <style>{`
        .sidebar {
          display: flex;
          width: 320px;
          background: #0f0f0f;
          border-right: 1px solid #1f1f1f;
          transition: width 0.2s ease;
        }

        .sidebar.collapsed {
          width: 56px;
        }

        .sidebar.collapsed .sidebar-nav {
          border-right: none;
        }

        .sidebar-nav {
          display: flex;
          flex-direction: column;
          width: 56px;
          padding: 0.75rem 0.5rem;
          gap: 0.25rem;
          border-right: 1px solid #1f1f1f;
          flex-shrink: 0;
        }

        .nav-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          background: transparent;
          border: none;
          border-radius: 4px;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
        }

        .nav-btn:hover {
          background: #1f1f1f;
          color: #9ca3af;
        }

        .nav-btn.active {
          background: #1f1f1f;
          color: #3b82f6;
        }

        .nav-btn.settings {
          margin-top: auto;
        }

        .nav-btn.collapse-btn {
          margin-top: 0.5rem;
        }

        .nav-btn.collapse-btn:hover {
          color: #e5e7eb;
        }

        .nav-btn svg {
          width: 1.25rem;
          height: 1.25rem;
        }

        .chat-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 1rem;
          gap: 1rem;
          background: linear-gradient(180deg, rgba(30, 58, 95, 0.3) 0%, rgba(15, 15, 15, 0) 50%);
        }

        .settings-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 1rem;
        }

        .settings-title {
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .settings-subtitle {
          font-size: 0.75rem;
          color: #6b7280;
        }

        .agent-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid #1f1f1f;
        }

        .agent-icon {
          width: 2.5rem;
          height: 2.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #1e3a5f 0%, #1e1e3f 100%);
          border-radius: 0.75rem;
          color: #60a5fa;
        }

        .agent-icon svg {
          width: 1.25rem;
          height: 1.25rem;
          display: block;
          flex-shrink: 0;
        }

        .agent-info {
          display: flex;
          flex-direction: column;
        }

        .agent-title {
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .agent-status {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
          color: #6b7280;
        }

        .agent-status .status-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
        }

        .messages {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          overflow-y: auto;
        }

        .message {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.25rem;
        }

        .message.assistant {
          align-items: flex-start;
        }

        .message-bubble {
          max-width: 85%;
          padding: 0.625rem 0.875rem;
          background: #2563eb;
          border-radius: 1rem;
          font-size: 0.875rem;
          color: #ffffff;
        }

        .message.assistant .message-bubble {
          background: #1f1f1f;
          color: #e5e7eb;
        }

        .message-time {
          font-size: 0.625rem;
          color: #6b7280;
        }

        .chat-input-container {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 0.75rem;
        }

        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #e5e7eb;
          font-size: 0.875rem;
        }

        .chat-input::placeholder {
          color: #4b5563;
        }

        .send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 2rem;
          height: 2rem;
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
          border-radius: 0.375rem;
          transition: all 0.15s;
        }

        .send-btn:hover {
          background: #2a2a2a;
          color: #9ca3af;
        }

        .send-btn svg {
          width: 1rem;
          height: 1rem;
        }
      `}</style>
    </aside>
  );
}

