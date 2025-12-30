import { useState } from 'react';
import { trpc } from '../utils/trpc';

interface DatabaseViewerProps {
  onClose: () => void;
}

type TableRow = Record<string, unknown>;

interface QueryResult {
  success: boolean;
  rowCount?: number;
  results?: TableRow[];
  error?: string;
}

export function DatabaseViewer({ onClose }: DatabaseViewerProps) {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [currentPage, setCurrentPage] = useState(0);
  const [customQuery, setCustomQuery] = useState('');
  const [queryResults, setQueryResults] = useState<QueryResult | null>(null);
  const [activeView, setActiveView] = useState<'tables' | 'query'>('tables');
  const pageSize = 50;

  // Fetch tables list
  const { data: tablesData, isLoading: tablesLoading } = trpc.getDatabaseTables.useQuery({});

  // Fetch table data when a table is selected
  const { data: tableData, isLoading: dataLoading } = trpc.getTableData.useQuery(
    {
      table: selectedTable,
      limit: pageSize,
      offset: currentPage * pageSize,
    },
    {
      enabled: !!selectedTable && activeView === 'tables',
    }
  );

  // Execute custom query
  const { mutate: executeQuery, isPending: queryLoading } = trpc.executeQuery.useMutation({
    onSuccess: (data) => {
      setQueryResults(data);
    },
  });

  const handleRunQuery = () => {
    if (customQuery.trim()) {
      executeQuery({ query: customQuery });
    }
  };

  if (tablesLoading) {
    return (
      <div className="database-viewer">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading database...</p>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  if (!tablesData?.tables || tablesData.tables.length === 0) {
    return (
      <div className="database-viewer">
        <div className="empty-state">
          <div className="empty-icon">🗄️</div>
          <h3 className="empty-title">No Database Found</h3>
          <p className="empty-text">Initialize the project with "raiken init" to create the database.</p>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  return (
    <div className="database-viewer">
      {/* Header */}
      <div className="db-header">
        <div className="header-left">
          <button className="close-btn" onClick={onClose} title="Close Database Viewer">
            ←
          </button>
          <h3 className="header-title">🗄️ Database Explorer</h3>
        </div>
        <div className="view-switcher">
          <button
            className={`view-btn ${activeView === 'tables' ? 'active' : ''}`}
            onClick={() => setActiveView('tables')}
          >
            📊 Tables
          </button>
          <button
            className={`view-btn ${activeView === 'query' ? 'active' : ''}`}
            onClick={() => setActiveView('query')}
          >
            🔍 Query
          </button>
        </div>
      </div>

      <div className="db-content">
        {/* Tables View */}
        {activeView === 'tables' && (
          <div className="tables-layout">
            {/* Sidebar: Table List */}
            <aside className="tables-sidebar">
              <h4 className="sidebar-title">TABLES ({tablesData.tables.length})</h4>
              <ul className="table-list">
                {tablesData.tables.map((table) => (
                  <li
                    key={table.name}
                    className={`table-item ${selectedTable === table.name ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedTable(table.name);
                      setCurrentPage(0);
                    }}
                  >
                    <span className="table-name">📋 {table.name}</span>
                    <span className="table-count">{table.rowCount}</span>
                  </li>
                ))}
              </ul>
            </aside>

            {/* Main: Table Data */}
            <main className="table-content">
              {selectedTable ? (
                <>
                  <div className="table-header">
                    <h4 className="table-title">{selectedTable}</h4>
                    {tableData && (
                      <span className="row-info">
                        Showing {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, tableData.total)} of {tableData.total} rows
                      </span>
                    )}
                  </div>

                  {dataLoading ? (
                    <div className="loading">
                      <div className="spinner"></div>
                      <p>Loading data...</p>
                    </div>
                  ) : tableData && tableData.data.length > 0 ? (
                    <>
                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {Object.keys(tableData.data[0]).map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tableData.data.map((row, idx) => (
                              <tr key={idx}>
                                {Object.values(row).map((val: unknown, colIdx) => (
                                  <td key={colIdx}>
                                    {val === null ? (
                                      <span className="null-value">NULL</span>
                                    ) : typeof val === 'object' ? (
                                      <span className="object-value">{JSON.stringify(val)}</span>
                                    ) : (
                                      String(val)
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="pagination">
                        <button
                          className="pagination-btn"
                          onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                          disabled={currentPage === 0}
                        >
                          ← Previous
                        </button>
                        <span className="page-info">Page {currentPage + 1}</span>
                        <button
                          className="pagination-btn"
                          onClick={() => setCurrentPage(p => p + 1)}
                          disabled={!tableData.hasMore}
                        >
                          Next →
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>No data available in this table</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="select-prompt">
                  <div className="select-prompt-icon">👈</div>
                  <p className="select-prompt-text">Select a table from the sidebar to view its contents</p>
                </div>
              )}
            </main>
          </div>
        )}

        {/* Query View */}
        {activeView === 'query' && (
          <div className="query-layout">
            <div className="query-editor">
              <h4 className="query-title">Custom SQL Query</h4>
              <p className="query-hint">💡 Only SELECT queries are allowed for safety</p>
              
              <textarea
                className="query-input"
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="SELECT * FROM files WHERE size > 1000 LIMIT 10;"
                rows={8}
              />
              
              <button 
                className="run-query-btn"
                onClick={handleRunQuery}
                disabled={queryLoading || !customQuery.trim()}
              >
                {queryLoading ? '⏳ Running...' : '▶ Run Query'}
              </button>
            </div>

            {queryResults && (
              <div className="query-results">
                {queryResults.success ? (
                  <>
                    <div className="results-success">
                      ✅ Query executed successfully - {queryResults.rowCount} rows returned
                    </div>
                    {queryResults.results && queryResults.results.length > 0 && (
                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {Object.keys(queryResults.results[0]).map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResults.results.map((row: TableRow, idx: number) => (
                              <tr key={idx}>
                                {Object.values(row).map((val: unknown, colIdx) => (
                                  <td key={colIdx}>
                                    {val === null ? (
                                      <span className="null-value">NULL</span>
                                    ) : typeof val === 'object' ? (
                                      <span className="object-value">{JSON.stringify(val)}</span>
                                    ) : (
                                      String(val)
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="results-error">
                    ❌ Error: {queryResults.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{styles}</style>
    </div>
  );
}

// Styles - Light theme for visibility
const styles = `
  /* Container */
  .database-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    justify-content: center;
    width: 100%;
    background-color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Header */
  .database-viewer .db-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background-color: #ffffff;
    border-bottom: 2px solid #e2e8f0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .database-viewer .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .database-viewer .close-btn {
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    color: #475569;
    font-size: 1.5rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .database-viewer .close-btn:hover {
    background-color: #e2e8f0;
  }

  .database-viewer .header-title {
    font-size: 1.5rem;
    margin: 0;
    font-weight: 600;
    color: #1e293b;
  }

  .database-viewer .view-switcher {
    display: flex;
    gap: 0.5rem;
    background-color: #f1f5f9;
    padding: 0.25rem;
    border-radius: 10px;
  }

  .database-viewer .view-btn {
    padding: 0.625rem 1.5rem;
    background-color: transparent;
    border: none;
    border-radius: 8px;
    color: #64748b;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .database-viewer .view-btn:hover {
    color: #475569;
  }

  .database-viewer .view-btn.active {
    background-color: #7C3AED;
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.3);
  }

  /* Content */
  .database-viewer .db-content {
    flex: 1;
    overflow: hidden;
    background-color: #f8fafc;
  }

  .database-viewer .tables-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    height: 100%;
  }

  /* Sidebar */
  .database-viewer .tables-sidebar {
    background-color: #ffffff;
    border-right: 2px solid #e2e8f0;
    padding: 1.5rem;
    overflow-y: auto;
  }

  .database-viewer .sidebar-title {
    font-size: 0.75rem;
    color: #64748b;
    text-transform: uppercase;
    margin: 0 0 1rem 0;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .database-viewer .table-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0;
    margin: 0;
  }

  .database-viewer .table-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.875rem 1rem;
    background-color: #f8fafc;
    border: 2px solid #e2e8f0;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s;
    color: #334155;
  }

  .database-viewer .table-item:hover {
    background-color: #f1f5f9;
    border-color: #cbd5e1;
  }

  .database-viewer .table-item.active {
    background-color: #7C3AED;
    border-color: #7C3AED;
    color: #ffffff;
    box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
    transform: translateX(4px);
  }

  .database-viewer .table-name {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .database-viewer .table-count {
    font-size: 0.8rem;
    font-weight: 700;
    background-color: rgba(0, 0, 0, 0.1);
    padding: 0.25rem 0.625rem;
    border-radius: 12px;
  }

  /* Table Content */
  .database-viewer .table-content {
    padding: 2rem;
    overflow-y: auto;
    background-color: #f8fafc;
  }

  .database-viewer .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background-color: #ffffff;
    border-radius: 10px;
    border: 2px solid #e2e8f0;
  }

  .database-viewer .table-title {
    font-size: 1.25rem;
    color: #7C3AED;
    margin: 0;
    font-weight: 700;
  }

  .database-viewer .row-info {
    color: #64748b;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .database-viewer .table-wrapper {
    overflow-x: auto;
    overflow-y: auto;
    max-height: calc(100vh - 300px);
    background-color: #ffffff;
    border-radius: 12px;
    border: 2px solid #e2e8f0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  }

  .database-viewer .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  .database-viewer .data-table th {
    background-color: #f1f5f9;
    padding: 1rem 1.25rem;
    text-align: left;
    font-weight: 700;
    color: #475569;
    position: sticky;
    top: 0;
    z-index: 10;
    border-bottom: 2px solid #cbd5e1;
    text-transform: uppercase;
    font-size: 0.8rem;
    letter-spacing: 0.05em;
  }

  .database-viewer .data-table tbody tr {
    transition: background-color 0.15s;
  }

  .database-viewer .data-table tbody tr:hover {
    background-color: #f8fafc;
  }

  .database-viewer .data-table td {
    padding: 0.875rem 1.25rem;
    border-bottom: 1px solid #e2e8f0;
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #334155;
  }

  .database-viewer .null-value {
    color: #94a3b8;
    font-style: italic;
    font-size: 0.85rem;
  }

  .database-viewer .object-value {
    color: #059669;
    font-family: monospace;
    font-size: 0.85rem;
  }

  /* Pagination */
  .database-viewer .pagination {
    display: flex;
    gap: 1rem;
    align-items: center;
    justify-content: center;
    padding-top: 1.5rem;
  }

  .database-viewer .pagination-btn {
    padding: 0.75rem 1.5rem;
    background-color: #7C3AED;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    font-weight: 600;
    font-size: 0.9rem;
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.3);
  }

  .database-viewer .pagination-btn:hover:not(:disabled) {
    background-color: #6D28D9;
    box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
  }

  .database-viewer .pagination-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
  }

  .database-viewer .page-info {
    color: #64748b;
    font-size: 0.95rem;
    font-weight: 600;
  }

  /* Query View */
  .database-viewer .query-layout {
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
    overflow-y: auto;
    height: 100%;
    background-color: #f8fafc;
  }

  .database-viewer .query-editor {
    background-color: #ffffff;
    padding: 2rem;
    border-radius: 12px;
    border: 2px solid #e2e8f0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  }

  .database-viewer .query-title {
    font-size: 1.25rem;
    margin: 0 0 0.5rem 0;
    font-weight: 700;
    color: #1e293b;
  }

  .database-viewer .query-hint {
    color: #64748b;
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .database-viewer .query-input {
    width: 100%;
    background-color: #f8fafc;
    border: 2px solid #cbd5e1;
    border-radius: 10px;
    padding: 1rem;
    color: #1e293b;
    font-family: "Fira Code", "Courier New", monospace;
    font-size: 0.9rem;
    resize: vertical;
    margin-bottom: 1rem;
    line-height: 1.6;
  }

  .database-viewer .query-input:focus {
    outline: none;
    border-color: #7C3AED;
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.1);
  }

  .database-viewer .run-query-btn {
    padding: 0.875rem 2rem;
    background-color: #10B981;
    color: white;
    border: none;
    border-radius: 8px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 1rem;
    box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
  }

  .database-viewer .run-query-btn:hover:not(:disabled) {
    background-color: #059669;
    box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4);
  }

  .database-viewer .run-query-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
  }

  .database-viewer .query-results {
    background-color: #ffffff;
    padding: 2rem;
    border-radius: 12px;
    border: 2px solid #e2e8f0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  }

  .database-viewer .results-success {
    color: #059669;
    font-weight: 600;
    margin-bottom: 1.5rem;
    padding: 1rem;
    background-color: #d1fae5;
    border-radius: 10px;
    font-size: 0.95rem;
    border: 2px solid #a7f3d0;
  }

  .database-viewer .results-error {
    color: #dc2626;
    font-weight: 600;
    padding: 1rem;
    background-color: #fee2e2;
    border-radius: 10px;
    font-size: 0.95rem;
    border: 2px solid #fecaca;
  }

  /* Loading & Empty States */
  .database-viewer .loading {
    text-align: center;
    padding: 4rem;
    color: #64748b;
    font-size: 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .database-viewer .spinner {
    border: 4px solid #e2e8f0;
    border-top: 4px solid #7C3AED;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .database-viewer .empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: #64748b;
    background-color: #ffffff;
    border-radius: 12px;
    border: 2px dashed #cbd5e1;
  }

  .database-viewer .empty-icon {
    font-size: 4rem;
    margin-bottom: 1rem;
    opacity: 0.5;
  }

  .database-viewer .empty-title {
    font-size: 1.5rem;
    margin-bottom: 0.5rem;
    color: #475569;
    font-weight: 600;
  }

  .database-viewer .empty-text {
    color: #64748b;
    font-size: 1rem;
  }

  .database-viewer .select-prompt {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #64748b;
    background-color: #ffffff;
    border-radius: 12px;
    border: 2px dashed #cbd5e1;
    padding: 3rem;
  }

  .database-viewer .select-prompt-icon {
    font-size: 4rem;
    margin-bottom: 1rem;
    opacity: 0.6;
  }

  .database-viewer .select-prompt-text {
    font-size: 1.125rem;
    font-weight: 500;
    margin: 0;
  }
`;
