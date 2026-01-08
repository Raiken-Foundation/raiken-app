import { useState } from 'react';

export interface TestResult {
  id: string;
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
  error?: {
    expected?: string;
    received?: string;
    message?: string;
  };
}

export interface TestSummary {
  suites: {
    passed: number;
    failed: number;
    total: number;
  };
  tests: {
    passed: number;
    failed: number;
    total: number;
  };
  time: number;
}

interface TestResultsProps {
  results: TestResult[];
  summary: TestSummary;
  filePath?: string;
}

export function TestResults({ results, summary, filePath }: TestResultsProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [selectedFailure, setSelectedFailure] = useState<string | null>(
    results.find(r => r.status === 'failed')?.id || null
  );

  const failedTests = results.filter(r => r.status === 'failed');

  return (
    <div className={`test-results ${isExpanded ? 'expanded' : 'collapsed'}`}>
      {/* Header */}
      <button className="results-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="header-left">
          <svg 
            className={`expand-icon ${isExpanded ? 'expanded' : ''}`} 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
          <span className="results-title">Test Results</span>
          <svg className="dropdown-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isExpanded && (
        <div className="results-content">
          {/* AI Insights Section */}
          {failedTests.length > 0 && (
            <div className="ai-insights">
              <div className="insights-header">
                <svg className="ai-icon" viewBox="0 0 24 24" fill="none">
                  <path 
                    d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" 
                    stroke="currentColor" 
                    strokeWidth="1.5" 
                    strokeLinejoin="round"
                  />
                </svg>
                <span>AI Insights</span>
              </div>

              {failedTests.map((test) => (
                <button
                  key={test.id}
                  className={`failure-item ${selectedFailure === test.id ? 'selected' : ''}`}
                  onClick={() => setSelectedFailure(test.id === selectedFailure ? null : test.id)}
                >
                  <svg className="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="failure-info">
                    <span className="failure-name">{test.suite} &gt; {test.name}</span>
                    <span className="failure-path">{filePath}</span>
                  </div>
                  <svg className="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          )}

          {/* Test Output */}
          <div className="test-output">
            {results.map((result) => (
              <div key={result.id} className={`output-line ${result.status}`}>
                <span className="status-symbol">
                  {result.status === 'passed' && '✓'}
                  {result.status === 'failed' && '✗'}
                  {result.status === 'skipped' && '○'}
                </span>
                <span className="test-path">
                  {result.suite} &gt; {result.name}
                </span>
                {result.duration && (
                  <span className="test-duration">({result.duration}ms)</span>
                )}
              </div>
            ))}
            
            {/* Error details for failed tests */}
            {results.filter(r => r.status === 'failed').map((result) => (
              result.error && (
                <div key={`${result.id}-error`} className="error-details">
                  {result.error.expected && (
                    <div className="error-line">
                      <span className="error-label">Expected:</span>
                      <span className="error-value">{result.error.expected}</span>
                    </div>
                  )}
                  {result.error.received && (
                    <div className="error-line">
                      <span className="error-label">Received:</span>
                      <span className="error-value">{result.error.received}</span>
                    </div>
                  )}
                </div>
              )
            ))}
          </div>

          {/* Summary */}
          <div className="test-summary">
            <div className="summary-row">
              <span className="summary-label">Test Suites:</span>
              {summary.suites.failed > 0 && (
                <span className="summary-value failed">{summary.suites.failed} failed,</span>
              )}
              <span className="summary-value passed">{summary.suites.passed} passed,</span>
              <span className="summary-value total">{summary.suites.total} total</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Tests:</span>
              {summary.tests.failed > 0 && (
                <span className="summary-value failed">{summary.tests.failed} failed,</span>
              )}
              <span className="summary-value passed">{summary.tests.passed} passed,</span>
              <span className="summary-value total">{summary.tests.total} total</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Time:</span>
              <span className="summary-value total">{summary.time.toFixed(3)}s</span>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .test-results {
          display: flex;
          flex-direction: column;
          width: 100%;
          background: #0a0a0a;
          border-top: 1px solid #1f1f1f;
          overflow: hidden;
          box-sizing: border-box;
          flex-shrink: 0;
          margin-top: auto;
        }

        .test-results.expanded {
          max-height: 45vh;
          min-height: 200px;
        }

        .test-results.collapsed {
          max-height: none;
          min-height: 0;
        }

        .results-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          background: #0f0f0f;
          border: none;
          cursor: pointer;
          width: 100%;
          text-align: left;
        }

        .test-results.expanded .results-header {
          border-bottom: 1px solid #1f1f1f;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .expand-icon {
          width: 1rem;
          height: 1rem;
          color: #6b7280;
          transition: transform 0.2s;
        }

        .expand-icon.expanded {
          transform: rotate(90deg);
        }

        .results-title {
          font-size: 0.8125rem;
          font-weight: 500;
          color: #9ca3af;
        }

        .dropdown-icon {
          width: 0.875rem;
          height: 0.875rem;
          color: #6b7280;
        }

        .results-content {
          flex: 1;
          overflow-y: auto;
        }

        .ai-insights {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid #1f1f1f;
        }

        .insights-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.75rem;
        }

        .ai-icon {
          width: 1.125rem;
          height: 1.125rem;
          color: #60a5fa;
        }

        .insights-header span {
          font-size: 0.8125rem;
          font-weight: 500;
          color: #9ca3af;
        }

        .failure-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          width: 100%;
          padding: 0.625rem 0.75rem;
          background: #18181b;
          border: 1px solid #27272a;
          border-radius: 0.5rem;
          cursor: pointer;
          text-align: left;
          transition: all 0.15s;
          margin-bottom: 0.5rem;
        }

        .failure-item:last-child {
          margin-bottom: 0;
        }

        .failure-item:hover {
          background: #1f1f23;
          border-color: #3f3f46;
        }

        .failure-item.selected {
          background: #1c1917;
          border-color: #451a03;
        }

        .error-icon {
          width: 1.125rem;
          height: 1.125rem;
          color: #ef4444;
          flex-shrink: 0;
        }

        .failure-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          min-width: 0;
        }

        .failure-name {
          font-size: 0.8125rem;
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .failure-path {
          font-size: 0.6875rem;
          color: #6b7280;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .chevron-icon {
          width: 1rem;
          height: 1rem;
          color: #6b7280;
          flex-shrink: 0;
        }

        .test-output {
          padding: 1rem;
          font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
          font-size: 0.75rem;
          line-height: 1.8;
        }

        .output-line {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
        }

        .status-symbol {
          width: 1rem;
          font-weight: 600;
        }

        .output-line.passed .status-symbol {
          color: #22c55e;
        }

        .output-line.failed .status-symbol {
          color: #ef4444;
        }

        .output-line.skipped .status-symbol {
          color: #6b7280;
        }

        .output-line.passed .test-path {
          color: #22c55e;
        }

        .output-line.failed .test-path {
          color: #ef4444;
        }

        .output-line.skipped .test-path {
          color: #6b7280;
        }

        .test-duration {
          color: #6b7280;
          font-size: 0.6875rem;
        }

        .error-details {
          padding: 0.5rem 0 0.5rem 1.5rem;
          color: #6b7280;
          font-size: 0.75rem;
        }

        .error-line {
          display: flex;
          gap: 0.5rem;
        }

        .error-label {
          color: #9ca3af;
        }

        .error-value {
          color: #ef4444;
        }

        .test-summary {
          padding: 0.75rem 1rem;
          border-top: 1px solid #1f1f1f;
          font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
          font-size: 0.75rem;
        }

        .summary-row {
          display: flex;
          gap: 0.5rem;
          line-height: 1.6;
        }

        .summary-label {
          color: #6b7280;
          width: 80px;
        }

        .summary-value {
          color: #9ca3af;
        }

        .summary-value.failed {
          color: #ef4444;
        }

        .summary-value.passed {
          color: #22c55e;
        }

        .summary-value.total {
          color: #9ca3af;
        }
      `}</style>
    </div>
  );
}

