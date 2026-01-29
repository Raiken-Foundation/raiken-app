import { useState, useEffect, useRef } from 'react';
import { trpc } from '../utils/trpc';

interface LandingPageProps {
  onStart?: (prompt: string) => void;
}

export function LandingPage({ onStart }: LandingPageProps) {
  const [prompt, setPrompt] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [projectName, setProjectName] = useState('Loading...');
  const inputRef = useRef<HTMLInputElement>(null);

  // Check backend health
  const healthQuery = trpc.getHealth.useQuery(undefined, {
    retry: 3,
    retryDelay: 1000,
  });

  // Get project info
  const projectQuery = trpc.getProjectInfo.useQuery(undefined, {
    enabled: healthQuery.isSuccess,
  });

  useEffect(() => {
    if (healthQuery.isSuccess) {
      setIsReady(true);
    }
  }, [healthQuery.isSuccess]);

  useEffect(() => {
    if (projectQuery.data?.path) {
      // Extract project name from path
      const parts = projectQuery.data.path.split('/');
      setProjectName(parts[parts.length - 1] || 'project');
    }
  }, [projectQuery.data]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && onStart) {
      onStart(prompt.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="landing-container">
      {/* Main Content */}
      <main className="landing-main">
        {/* Logo */}
        <h1 className="landing-logo">Raiken</h1>
        <p className="landing-subtitle">AI Test Engineer</p>

        {/* Project Selector */}
        <button type="button" className="project-selector">
          <svg 
            className="project-icon" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span>{projectName}</span>
        </button>

        {/* Command Input */}
        <form onSubmit={handleSubmit} className="command-form">
          <div className="command-input-wrapper">
            <svg 
              className="command-icon" 
              viewBox="0 0 24 24" 
              fill="none"
              aria-hidden="true"
            >
              <path 
                d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                strokeLinejoin="round"
              />
              <path 
                d="M5 19l1 3 3-1-1-3-3 1z" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                strokeLinejoin="round"
              />
              <path 
                d="M19 19l-1 3-3-1 1-3 3 1z" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                strokeLinejoin="round"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What do you want to test today?"
              className="command-input"
              disabled={!isReady}
            />
            <button 
              type="submit" 
              className="command-submit"
              disabled={!prompt.trim() || !isReady}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </form>

        {/* Status Indicator */}
        <div className="status-indicator">
          <span className={`status-dot ${isReady ? 'ready' : 'loading'}`} />
          <span className="status-text">
            {isReady ? 'Ready' : 'Connecting...'}
          </span>
        </div>
      </main>

      {/* Footer Hint */}
      <footer className="landing-footer">
        <span className="hint-text">
          Press <kbd>Enter</kbd> to begin
        </span>
      </footer>

      <style>{`
        .landing-container {
          min-height: 100vh;
          background: #0a0a0a;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          position: relative;
        }

        .landing-main {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
          max-width: 700px;
          width: 100%;
        }

        .landing-logo {
          font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 5rem;
          font-weight: 300;
          letter-spacing: -0.02em;
          color: #ffffff;
          margin: 0;
          background: linear-gradient(180deg, #ffffff 0%, #a0a0a0 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .landing-subtitle {
          font-size: 1.125rem;
          color: #6b7280;
          margin: 0 0 1.5rem 0;
          font-weight: 400;
          letter-spacing: 0.02em;
        }

        .project-selector {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.625rem 1rem;
          background: transparent;
          border: 1px solid #2a2a2a;
          border-radius: 9999px;
          color: #9ca3af;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s ease;
          margin-bottom: 2rem;
        }

        .project-selector:hover {
          border-color: #3a3a3a;
          color: #d1d5db;
        }

        .project-icon {
          width: 1rem;
          height: 1rem;
        }

        .command-form {
          width: 100%;
          max-width: 600px;
          position: relative;
        }

        .command-form::before {
          content: '';
          position: absolute;
          inset: -2px;
          background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #ec4899 100%);
          border-radius: 1.125rem;
          opacity: 0.4;
          filter: blur(12px);
          z-index: -1;
          transition: opacity 0.3s ease;
        }

        .command-form:focus-within::before {
          opacity: 0.6;
        }

        .command-input-wrapper {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 1rem 1.25rem;
          background: #18181b;
          border: 1px solid #27272a;
          border-radius: 1rem;
          transition: all 0.2s ease;
          position: relative;
          z-index: 1;
        }

        .command-input-wrapper:focus-within {
          border-color: #3f3f46;
        }

        .command-icon {
          width: 1.5rem;
          height: 1.5rem;
          color: #3b82f6;
          flex-shrink: 0;
        }

        .command-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #e5e7eb;
          font-size: 1rem;
          font-weight: 400;
        }

        .command-input::placeholder {
          color: #6b7280;
        }

        .command-input:disabled {
          opacity: 0.5;
        }

        .command-submit {
          width: 2rem;
          height: 2rem;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: #4b5563;
          cursor: pointer;
          border-radius: 0.5rem;
          transition: all 0.2s ease;
        }

        .command-submit:hover:not(:disabled) {
          color: #9ca3af;
          background: #27272a;
        }

        .command-submit:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }

        .command-submit svg {
          width: 1.25rem;
          height: 1.25rem;
        }

        .status-indicator {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-top: 1.5rem;
        }

        .status-dot {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          transition: all 0.3s ease;
        }

        .status-dot.ready {
          background: #22c55e;
          box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
        }

        .status-dot.loading {
          background: #eab308;
          animation: pulse 1.5s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .status-text {
          font-size: 0.875rem;
          color: #9ca3af;
        }

        .landing-footer {
          position: absolute;
          bottom: 2rem;
          left: 50%;
          transform: translateX(-50%);
        }

        .hint-text {
          font-size: 0.875rem;
          color: #4b5563;
        }

        .hint-text kbd {
          display: inline-block;
          padding: 0.125rem 0.5rem;
          background: #27272a;
          border: 1px solid #3f3f46;
          border-radius: 0.375rem;
          font-family: inherit;
          font-size: 0.75rem;
          color: #9ca3af;
          margin: 0 0.25rem;
        }
      `}</style>
    </div>
  );
}

export default LandingPage;

