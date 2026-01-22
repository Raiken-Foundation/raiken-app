import { useState } from 'react';

// Helper function to strip ANSI codes from error messages
function stripAnsiCodes(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1F\x7F]/g, '');
}

export interface TestAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

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
    snippet?: string;
    location?: {
      file: string;
      line: number;
      column: number;
  };
  };
  attachments?: TestAttachment[];
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
  isRunning?: boolean;
  rawOutput?: string;
  testCode?: string;
  onRequestInterpretation?: (results: TestResult[], testCode: string) => void;
  interpretation?: string;
  isInterpreting?: boolean;
}

export function TestResults({ 
  results, 
  summary, 
  filePath: _filePath, 
  isRunning, 
  rawOutput,
  testCode,
  onRequestInterpretation,
  interpretation,
  isInterpreting
}: TestResultsProps) {
  void _filePath; // Reserved for future use
  const [isExpanded, setIsExpanded] = useState(true);
  const [selectedTest, setSelectedTest] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'artifacts' | 'raw' | 'insights'>('formatted');

  const failedTests = results.filter(r => r.status === 'failed');
  const passedTests = results.filter(r => r.status === 'passed');
  const hasResults = results.length > 0;

  // Switch to insights view when interpretation is available
  const handleAnalyzeClick = () => {
    if (onRequestInterpretation && testCode) {
      onRequestInterpretation(results, testCode);
      setViewMode('insights');
    }
  };

  // Get the selected test details
  const selectedTestDetails = selectedTest ? results.find(r => r.id === selectedTest) : null;

  return (
    <div className={`test-results ${isExpanded ? 'expanded' : 'collapsed'}`}>
      {/* Header with Summary Badge */}
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
          {hasResults && !isRunning && (
            <div className="header-badges">
              {passedTests.length > 0 && (
                <span className="badge passed">{passedTests.length} passed</span>
              )}
              {failedTests.length > 0 && (
                <span className="badge failed">{failedTests.length} failed</span>
              )}
            </div>
          )}
          {isRunning && (
            <span className="badge running">Running...</span>
          )}
        </div>
        <div className="header-right">
          {hasResults && summary.time > 0 && (
            <span className="header-time">{summary.time.toFixed(2)}s</span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="results-content">
          {/* Running State */}
          {isRunning && (
            <div className="running-state">
              <div className="running-spinner"></div>
              <span>Running tests...</span>
              <span className="running-hint">This may take a few moments</span>
            </div>
          )}

          {/* Empty State - Instructions */}
          {!isRunning && !hasResults && !rawOutput && (
            <div className="empty-state">
              <svg className="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M5 3l14 9-14 9V3z" />
                </svg>
              <h3>Ready to Run Tests</h3>
              <p>Select a test file from the editor and click "Run Tests" to execute it.</p>
              <div className="empty-tips">
                <h4>Test Execution Tips:</h4>
                <ul>
                  <li>Tests run against your app at <code>localhost:5173</code></li>
                  <li>Make sure your dev server is running</li>
                  <li>Failed tests will show error details and screenshots</li>
                </ul>
              </div>
            </div>
          )}

          {/* View Mode Toggle */}
          {!isRunning && (hasResults || rawOutput) && (
            <div className="view-toggle">
              <div className="toggle-group">
                <button
                  className={`toggle-btn ${viewMode === 'formatted' ? 'active' : ''}`}
                  onClick={() => setViewMode('formatted')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  Results
                </button>
                <button 
                  className={`toggle-btn ${viewMode === 'insights' ? 'active' : ''}`}
                  onClick={() => setViewMode('insights')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  AI Insights
                </button>
                <button
                  className={`toggle-btn ${viewMode === 'artifacts' ? 'active' : ''}`}
                  onClick={() => setViewMode('artifacts')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Artifacts
                </button>
                <button
                  className={`toggle-btn ${viewMode === 'raw' ? 'active' : ''}`}
                  onClick={() => setViewMode('raw')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                  Raw
                </button>
                  </div>
              {hasResults && testCode && onRequestInterpretation && (
                <button 
                  className="analyze-btn"
                  onClick={handleAnalyzeClick}
                  disabled={isInterpreting}
                >
                  {isInterpreting ? (
                    <>
                      <div className="btn-spinner"></div>
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                      Analyze with AI
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Artifacts View */}
          {!isRunning && viewMode === 'artifacts' && (
            <div className="artifacts-view">
              {(() => {
                // Collect all artifacts from all test results
                const allArtifacts = results.flatMap(r => 
                  (r.attachments || []).map(a => ({ ...a, testName: r.name, testStatus: r.status }))
                );
                
                const screenshots = allArtifacts.filter(a => a.contentType?.startsWith('image/'));
                const videos = allArtifacts.filter(a => a.contentType?.includes('video'));
                const traces = allArtifacts.filter(a => a.name?.includes('trace'));
                const other = allArtifacts.filter(a => 
                  !a.contentType?.startsWith('image/') && 
                  !a.contentType?.includes('video') && 
                  !a.name?.includes('trace')
                );
                
                if (allArtifacts.length === 0) {
                  return (
                    <div className="no-artifacts">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <h3>No Artifacts Available</h3>
                      <p>Run tests with screenshot/video capture enabled to see artifacts here.</p>
                      <div className="artifact-tips">
                        <h4>Enable in playwright.config.ts:</h4>
                        <pre>{`use: {
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  trace: 'retain-on-failure',
}`}</pre>
                      </div>
                    </div>
                  );
                }
                
                return (
                  <div className="artifacts-content">
                    {/* Screenshots Section */}
                    {screenshots.length > 0 && (
                      <div className="artifact-section">
                        <h4>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Screenshots ({screenshots.length})
                        </h4>
                        <div className="artifact-grid">
                          {screenshots.map((s, i) => (
                            <div key={i} className={`artifact-card ${s.testStatus}`}>
                              <div className="artifact-preview">
                                {s.path ? (
                                  <img src={`/api/artifact?path=${encodeURIComponent(s.path)}`} alt={s.name} />
                                ) : (
                                  <div className="placeholder-image">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                      <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                    </svg>
                                  </div>
                                )}
                              </div>
                              <div className="artifact-info">
                                <span className="artifact-name">{s.name}</span>
                                <span className="artifact-test">{s.testName}</span>
                              </div>
                            </div>
                          ))}
                        </div>
            </div>
          )}

                    {/* Videos Section */}
                    {videos.length > 0 && (
                      <div className="artifact-section">
                        <h4>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Videos ({videos.length})
                        </h4>
                        <div className="artifact-list">
                          {videos.map((v, i) => (
                            <div key={i} className={`artifact-item video ${v.testStatus}`}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                              <div className="item-info">
                                <span className="item-name">{v.name}</span>
                                <span className="item-test">{v.testName}</span>
                              </div>
                              {v.path && (
                                <a href={`/api/artifact?path=${encodeURIComponent(v.path)}`} target="_blank" rel="noopener noreferrer" className="view-btn">
                                  View
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Traces Section */}
                    {traces.length > 0 && (
                      <div className="artifact-section">
                        <h4>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                          </svg>
                          Traces ({traces.length})
                        </h4>
                        <div className="artifact-list">
                          {traces.map((t, i) => (
                            <div key={i} className={`artifact-item trace ${t.testStatus}`}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                              </svg>
                              <div className="item-info">
                                <span className="item-name">{t.name}</span>
                                <span className="item-test">{t.testName}</span>
                              </div>
                              {t.path && (
                                <a href={`/api/artifact?path=${encodeURIComponent(t.path)}`} target="_blank" rel="noopener noreferrer" className="view-btn">
                                  Open Trace Viewer
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Other Artifacts */}
                    {other.length > 0 && (
                      <div className="artifact-section">
                        <h4>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          Other Files ({other.length})
                        </h4>
                        <div className="artifact-list">
                          {other.map((o, i) => (
                            <div key={i} className={`artifact-item other ${o.testStatus}`}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <div className="item-info">
                                <span className="item-name">{o.name}</span>
                                <span className="item-test">{o.testName}</span>
                              </div>
                              <span className="item-type">{o.contentType}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Raw Output View */}
          {!isRunning && viewMode === 'raw' && rawOutput && (
            <div className="raw-output">
              <pre>{rawOutput}</pre>
            </div>
          )}

          {/* AI Insights View */}
          {!isRunning && viewMode === 'insights' && (
            <div className="insights-view">
              {isInterpreting ? (
                <div className="interpreting-state">
                  <div className="interpreting-spinner"></div>
                  <h3>Analyzing Test Results...</h3>
                  <p>AI is reviewing your code, DOM context, and test results to provide insights.</p>
                </div>
              ) : interpretation ? (
                <div className="interpretation-content">
                  <div className="interpretation-header">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <h3>AI Analysis</h3>
                  </div>
                  <div className="interpretation-body">
                    {interpretation.split('\n').map((line, i) => {
                      // Handle headers
                      if (line.startsWith('### ')) {
                        return <h4 key={i} className="int-h4">{line.replace('### ', '')}</h4>;
                      }
                      if (line.startsWith('## ')) {
                        return <h3 key={i} className="int-h3">{line.replace('## ', '')}</h3>;
                      }
                      if (line.startsWith('# ')) {
                        return <h2 key={i} className="int-h2">{line.replace('# ', '')}</h2>;
                      }
                      // Handle bold
                      if (line.startsWith('**') && line.endsWith('**')) {
                        return <p key={i} className="int-bold">{line.replace(/\*\*/g, '')}</p>;
                      }
                      // Handle bullet points
                      if (line.startsWith('- ')) {
                        return <li key={i}>{line.replace('- ', '')}</li>;
                      }
                      // Handle code blocks (simple)
                      if (line.startsWith('```')) {
                        return null;
                      }
                      // Empty lines
                      if (line.trim() === '') {
                        return <br key={i} />;
                      }
                      return <p key={i}>{line}</p>;
                    })}
                  </div>
                </div>
              ) : (
                <div className="no-insights">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  <h3>No Analysis Yet</h3>
                  <p>Click "Analyze with AI" to get intelligent insights about your test results.</p>
                  {testCode && onRequestInterpretation && (
                    <button className="start-analysis-btn" onClick={handleAnalyzeClick}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Start Analysis
                </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Formatted Results View */}
          {!isRunning && viewMode === 'formatted' && hasResults && (
            <div className="formatted-results">
              {/* Test List */}
              <div className="test-list">
            {results.map((result) => (
                  <button
                    key={result.id}
                    className={`test-item ${result.status} ${selectedTest === result.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTest(selectedTest === result.id ? null : result.id)}
                  >
                    <span className="status-icon">
                      {result.status === 'passed' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {result.status === 'failed' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                      {result.status === 'skipped' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                        </svg>
                      )}
                </span>
                    <div className="test-info">
                      <span className="test-name">{result.name}</span>
                      <span className="test-suite">{result.suite}</span>
                    </div>
                {result.duration && (
                      <span className="test-duration">{result.duration}ms</span>
                    )}
                    <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>

              {/* Selected Test Details */}
              {selectedTestDetails && (
                <div className="test-details">
                  <div className="details-header">
                    <span className={`status-badge ${selectedTestDetails.status}`}>
                      {selectedTestDetails.status.toUpperCase()}
                    </span>
                    <h3>{selectedTestDetails.name}</h3>
                    {selectedTestDetails.duration && (
                      <span className="duration">{selectedTestDetails.duration}ms</span>
                    )}
                  </div>

                  {/* Error Details */}
                  {selectedTestDetails.error && (
                    <div className="error-section">
                      <h4>Error Details</h4>
                      {selectedTestDetails.error.message && (
                        <div className="error-message">
                          {stripAnsiCodes(selectedTestDetails.error.message)}
                    </div>
                  )}
                      {selectedTestDetails.error.snippet && (
                        <pre className="error-snippet">
                          {selectedTestDetails.error.snippet}
                        </pre>
                      )}
                      {selectedTestDetails.error.location && (
                        <div className="error-location">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <span>{selectedTestDetails.error.location.file.split('/').pop()}:{selectedTestDetails.error.location.line}:{selectedTestDetails.error.location.column}</span>
                    </div>
                  )}
                </div>
                  )}

                  {/* Attachments/Artifacts */}
                  {selectedTestDetails.attachments && selectedTestDetails.attachments.length > 0 && (
                    <div className="attachments-section">
                      <h4>Artifacts</h4>
                      <div className="attachments-list">
                        {selectedTestDetails.attachments.map((attachment, idx) => (
                          <div key={idx} className="attachment-item">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              {attachment.contentType.startsWith('image/') ? (
                                <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              ) : attachment.contentType.includes('video') ? (
                                <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              ) : (
                                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              )}
                            </svg>
                            <span className="attachment-name">{attachment.name}</span>
                            <span className="attachment-type">{attachment.contentType}</span>
              </div>
            ))}
          </div>
                    </div>
                  )}

                  {/* Success message for passed tests */}
                  {selectedTestDetails.status === 'passed' && (
                    <div className="success-message">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Test passed successfully in {selectedTestDetails.duration}ms</span>
                    </div>
                  )}
            </div>
              )}

              {/* Summary Bar */}
              <div className="summary-bar">
                <div className="summary-stats">
                  <span className="stat">
                    <strong>{summary.tests.total}</strong> tests
                  </span>
                  <span className="stat passed">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    {summary.tests.passed} passed
                  </span>
              {summary.tests.failed > 0 && (
                    <span className="stat failed">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      {summary.tests.failed} failed
                    </span>
                  )}
            </div>
                <span className="summary-time">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {summary.time.toFixed(2)}s
                </span>
            </div>
          </div>
          )}
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
        }

        .test-results.expanded {
          max-height: 50vh;
          min-height: 250px;
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
        }

        .test-results.expanded .results-header {
          border-bottom: 1px solid #1f1f1f;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .header-right {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .header-time {
          font-size: 0.75rem;
          color: #6b7280;
          font-family: 'JetBrains Mono', monospace;
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
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .header-badges {
          display: flex;
          gap: 0.5rem;
        }

        .badge {
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.6875rem;
          font-weight: 500;
        }

        .badge.passed {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
        }

        .badge.failed {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }

        .badge.running {
          background: rgba(59, 130, 246, 0.15);
          color: #3b82f6;
        }

        .results-content {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }

        /* Running State */
        .running-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 3rem 2rem;
          flex: 1;
        }

        .running-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid #1f1f1f;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        .running-state span {
          color: #3b82f6;
          font-weight: 500;
        }

        .running-hint {
          font-size: 0.75rem;
          color: #6b7280 !important;
          font-weight: 400 !important;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Empty State */
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          flex: 1;
          text-align: center;
        }

        .empty-icon {
          width: 3rem;
          height: 3rem;
          color: #3b82f6;
          margin-bottom: 1rem;
        }

        .empty-state h3 {
          margin: 0 0 0.5rem;
          font-size: 1rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .empty-state p {
          margin: 0 0 1.5rem;
          font-size: 0.875rem;
          color: #6b7280;
        }

        .empty-tips {
          background: #18181b;
          border-radius: 8px;
          padding: 1rem;
          text-align: left;
          max-width: 400px;
        }

        .empty-tips h4 {
          margin: 0 0 0.5rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .empty-tips ul {
          margin: 0;
          padding: 0 0 0 1rem;
          font-size: 0.8125rem;
          color: #9ca3af;
        }

        .empty-tips li {
          margin-bottom: 0.25rem;
        }

        .empty-tips code {
          background: #27272a;
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-size: 0.75rem;
          color: #a78bfa;
        }

        /* View Toggle */
        .view-toggle {
          display: flex;
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid #1f1f1f;
          background: #0f0f0f;
        }

        .toggle-btn {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.375rem 0.75rem;
          background: transparent;
          border: 1px solid #27272a;
          border-radius: 6px;
          color: #6b7280;
          font-size: 0.75rem;
          cursor: pointer;
          transition: all 0.15s;
        }

        .toggle-btn svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .toggle-btn:hover {
          background: #18181b;
          color: #9ca3af;
        }

        .toggle-btn.active {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }

        /* Raw Output */
        .raw-output {
          padding: 1rem;
          overflow: auto;
          flex: 1;
        }

        .raw-output pre {
          margin: 0;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6875rem;
          line-height: 1.6;
          color: #9ca3af;
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* Formatted Results */
        .formatted-results {
          display: flex;
          flex-direction: column;
          flex: 1;
          overflow: hidden;
        }

        .test-list {
          flex: 1;
          overflow-y: auto;
          padding: 0.5rem;
        }

        .test-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          width: 100%;
          padding: 0.625rem 0.75rem;
          background: #0f0f0f;
          border: 1px solid #1f1f1f;
          border-radius: 6px;
          cursor: pointer;
          text-align: left;
          margin-bottom: 0.375rem;
          transition: all 0.15s;
        }

        .test-item:hover {
          background: #18181b;
          border-color: #27272a;
        }

        .test-item.selected {
          background: #18181b;
          border-color: #3b82f6;
        }

        .test-item .status-icon {
          width: 1.25rem;
          height: 1.25rem;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .test-item .status-icon svg {
          width: 1rem;
          height: 1rem;
        }

        .test-item.passed .status-icon {
          color: #22c55e;
        }

        .test-item.failed .status-icon {
          color: #ef4444;
        }

        .test-item.skipped .status-icon {
          color: #6b7280;
        }

        .test-info {
          flex: 1;
          min-width: 0;
        }

        .test-name {
          display: block;
          font-size: 0.8125rem;
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .test-suite {
          display: block;
          font-size: 0.6875rem;
          color: #6b7280;
        }

        .test-duration {
          font-size: 0.6875rem;
          color: #6b7280;
          font-family: 'JetBrains Mono', monospace;
        }

        .test-item .chevron {
          width: 1rem;
          height: 1rem;
          color: #4b5563;
          transition: transform 0.15s;
        }

        .test-item.selected .chevron {
          transform: rotate(90deg);
          color: #3b82f6;
        }

        /* Test Details Panel */
        .test-details {
          background: #0f0f0f;
          border-top: 1px solid #1f1f1f;
          padding: 1rem;
          max-height: 40%;
          overflow-y: auto;
        }

        .details-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .status-badge {
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.625rem;
          font-weight: 600;
          letter-spacing: 0.05em;
        }

        .status-badge.passed {
          background: rgba(34, 197, 94, 0.2);
          color: #22c55e;
        }

        .status-badge.failed {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .details-header h3 {
          margin: 0;
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
          flex: 1;
        }

        .details-header .duration {
          font-size: 0.75rem;
          color: #6b7280;
          font-family: 'JetBrains Mono', monospace;
        }

        .error-section {
          background: rgba(239, 68, 68, 0.05);
          border: 1px solid rgba(239, 68, 68, 0.2);
          border-radius: 8px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .error-section h4 {
          margin: 0 0 0.75rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: #ef4444;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .error-message {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.75rem;
          color: #fca5a5;
          margin-bottom: 0.75rem;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .error-snippet {
          background: #0a0a0a;
          border-radius: 6px;
          padding: 0.75rem;
          margin: 0 0 0.75rem;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6875rem;
          color: #9ca3af;
          overflow-x: auto;
          white-space: pre;
        }

        .error-location {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.75rem;
          color: #6b7280;
        }

        .error-location svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .attachments-section {
          margin-bottom: 1rem;
        }

        .attachments-section h4 {
          margin: 0 0 0.75rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: #9ca3af;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .attachments-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .attachment-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.625rem 0.75rem;
          background: #18181b;
          border: 1px solid #27272a;
          border-radius: 6px;
        }

        .attachment-item svg {
          width: 1.125rem;
          height: 1.125rem;
          color: #6b7280;
        }

        .attachment-name {
          flex: 1;
          font-size: 0.8125rem;
          color: #e5e7eb;
        }

        .attachment-type {
          font-size: 0.6875rem;
          color: #6b7280;
        }

        .success-message {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 1rem;
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.2);
          border-radius: 8px;
          color: #22c55e;
        }

        .success-message svg {
          width: 1.5rem;
          height: 1.5rem;
          flex-shrink: 0;
        }

        .success-message span {
          font-size: 0.875rem;
        }

        /* Summary Bar */
        .summary-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          background: #0f0f0f;
          border-top: 1px solid #1f1f1f;
        }

        .summary-stats {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .stat {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
          color: #9ca3af;
        }

        .stat svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .stat.passed {
          color: #22c55e;
        }

        .stat.failed {
          color: #ef4444;
        }

        .stat strong {
          color: #e5e7eb;
        }

        .summary-time {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
          color: #6b7280;
          font-family: 'JetBrains Mono', monospace;
        }

        .summary-time svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        /* View Toggle Enhancements */
        .view-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .toggle-group {
          display: flex;
          gap: 0.25rem;
        }

        .analyze-btn {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0.875rem;
          background: linear-gradient(135deg, #8b5cf6, #6366f1);
          border: none;
          border-radius: 6px;
          color: white;
          font-size: 0.75rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .analyze-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
        }

        .analyze-btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }

        .analyze-btn svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .btn-spinner {
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        /* Insights View */
        .insights-view {
          flex: 1;
          overflow-y: auto;
          padding: 1rem;
        }

        .interpreting-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          padding: 3rem 2rem;
          text-align: center;
        }

        .interpreting-spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #1f1f1f;
          border-top-color: #8b5cf6;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        .interpreting-state h3 {
          margin: 0;
          font-size: 1rem;
          color: #e5e7eb;
        }

        .interpreting-state p {
          margin: 0;
          font-size: 0.875rem;
          color: #6b7280;
        }

        .interpretation-content {
          background: #0f0f0f;
          border-radius: 8px;
          border: 1px solid #1f1f1f;
        }

        .interpretation-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 1rem;
          border-bottom: 1px solid #1f1f1f;
        }

        .interpretation-header svg {
          width: 1.25rem;
          height: 1.25rem;
          color: #8b5cf6;
        }

        .interpretation-header h3 {
          margin: 0;
          font-size: 0.875rem;
          font-weight: 600;
          color: #e5e7eb;
        }

        .interpretation-body {
          padding: 1rem;
          font-size: 0.8125rem;
          color: #d1d5db;
          line-height: 1.7;
        }

        .interpretation-body p {
          margin: 0 0 0.5rem;
        }

        .interpretation-body .int-h2 {
          margin: 1.5rem 0 0.75rem;
          font-size: 1.125rem;
          font-weight: 600;
          color: #f3f4f6;
        }

        .interpretation-body .int-h3 {
          margin: 1.25rem 0 0.5rem;
          font-size: 1rem;
          font-weight: 600;
          color: #e5e7eb;
        }

        .interpretation-body .int-h4 {
          margin: 1rem 0 0.5rem;
          font-size: 0.875rem;
          font-weight: 600;
          color: #d1d5db;
        }

        .interpretation-body .int-bold {
          font-weight: 600;
          color: #f3f4f6;
        }

        .interpretation-body li {
          margin-left: 1rem;
          margin-bottom: 0.25rem;
        }

        .interpretation-body code {
          background: #27272a;
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.75rem;
          color: #a78bfa;
        }

        .no-insights {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 3rem 2rem;
          text-align: center;
        }

        .no-insights svg {
          width: 3rem;
          height: 3rem;
          color: #4b5563;
        }

        .no-insights h3 {
          margin: 0;
          font-size: 1rem;
          color: #9ca3af;
        }

        .no-insights p {
          margin: 0;
          font-size: 0.875rem;
          color: #6b7280;
          max-width: 300px;
        }

        .start-analysis-btn {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.625rem 1rem;
          margin-top: 1rem;
          background: linear-gradient(135deg, #8b5cf6, #6366f1);
          border: none;
          border-radius: 8px;
          color: white;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .start-analysis-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(139, 92, 246, 0.35);
        }

        .start-analysis-btn svg {
          width: 1rem;
          height: 1rem;
        }

        /* Artifacts View */
        .artifacts-view {
          flex: 1;
          overflow-y: auto;
          padding: 1rem;
        }

        .no-artifacts {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 3rem 2rem;
          text-align: center;
        }

        .no-artifacts svg {
          width: 3rem;
          height: 3rem;
          color: #4b5563;
        }

        .no-artifacts h3 {
          margin: 0;
          font-size: 1rem;
          color: #9ca3af;
        }

        .no-artifacts p {
          margin: 0;
          font-size: 0.875rem;
          color: #6b7280;
        }

        .artifact-tips {
          margin-top: 1rem;
          background: #18181b;
          border-radius: 8px;
          padding: 1rem;
          text-align: left;
        }

        .artifact-tips h4 {
          margin: 0 0 0.5rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: #9ca3af;
        }

        .artifact-tips pre {
          margin: 0;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6875rem;
          color: #a78bfa;
          background: #0f0f0f;
          padding: 0.75rem;
          border-radius: 6px;
        }

        .artifacts-content {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .artifact-section h4 {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin: 0 0 0.75rem;
          font-size: 0.8125rem;
          font-weight: 600;
          color: #e5e7eb;
        }

        .artifact-section h4 svg {
          width: 1rem;
          height: 1rem;
          color: #6b7280;
        }

        .artifact-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 0.75rem;
        }

        .artifact-card {
          background: #0f0f0f;
          border: 1px solid #1f1f1f;
          border-radius: 8px;
          overflow: hidden;
          transition: all 0.15s;
        }

        .artifact-card:hover {
          border-color: #27272a;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        .artifact-card.failed {
          border-color: rgba(239, 68, 68, 0.3);
        }

        .artifact-preview {
          width: 100%;
          height: 120px;
          background: #18181b;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .artifact-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          cursor: pointer;
        }

        .placeholder-image {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }

        .placeholder-image svg {
          width: 2rem;
          height: 2rem;
          color: #4b5563;
        }

        .artifact-info {
          padding: 0.625rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .artifact-name {
          font-size: 0.75rem;
          font-weight: 500;
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .artifact-test {
          font-size: 0.6875rem;
          color: #6b7280;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .artifact-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .artifact-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem;
          background: #0f0f0f;
          border: 1px solid #1f1f1f;
          border-radius: 8px;
          transition: all 0.15s;
        }

        .artifact-item:hover {
          background: #18181b;
          border-color: #27272a;
        }

        .artifact-item.failed {
          border-color: rgba(239, 68, 68, 0.3);
        }

        .artifact-item svg {
          width: 1.25rem;
          height: 1.25rem;
          color: #6b7280;
          flex-shrink: 0;
        }

        .artifact-item.video svg {
          color: #8b5cf6;
        }

        .artifact-item.trace svg {
          color: #3b82f6;
        }

        .item-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
        }

        .item-name {
          font-size: 0.8125rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .item-test {
          font-size: 0.6875rem;
          color: #6b7280;
        }

        .item-type {
          font-size: 0.6875rem;
          color: #4b5563;
          font-family: 'JetBrains Mono', monospace;
        }

        .view-btn {
          padding: 0.375rem 0.75rem;
          background: #27272a;
          border: 1px solid #3f3f46;
          border-radius: 6px;
          color: #e5e7eb;
          font-size: 0.75rem;
          font-weight: 500;
          text-decoration: none;
          transition: all 0.15s;
        }

        .view-btn:hover {
          background: #3f3f46;
          color: #ffffff;
        }
      `}</style>
    </div>
  );
}
