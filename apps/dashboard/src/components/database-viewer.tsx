import { useState } from 'react';
import { trpc } from '../utils/trpc';

interface DatabaseViewerProps {
  onClose: () => void;
}

export function DatabaseViewer({ onClose }: DatabaseViewerProps) {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [currentPage, setCurrentPage] = useState(0);
  const [customQuery, setCustomQuery] = useState('');
  const [queryResults, setQueryResults] = useState<any>(null);
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
      <div className="raiken-db-viewer">
        <div className="loading">Loading database...</div>
      </div>
    );
  }

  if (!tablesData?.tables || tablesData.tables.length === 0) {
    return (
      <div className="raiken-db-viewer">
        <div className="empty-state">
          <div className="empty-icon">🗄️</div>
          <h3>No Database Found</h3>
          <p>Initialize the project with "raiken init" to create the database.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="raiken-db-viewer">
      {/* Header */}
      <div className="raiken-db-header">
        <div className="header-left">
          <button className="close-btn" onClick={onClose} title="Close Database Viewer">
            ←
          </button>
          <h3>🗄️ Database Explorer</h3>
        </div>
        <div className="view-switcher">
          <button
            className={activeView === 'tables' ? 'active' : ''}
            onClick={() => setActiveView('tables')}
          >
            Tables
          </button>
          <button
            className={activeView === 'query' ? 'active' : ''}
            onClick={() => setActiveView('query')}
          >
            Query
          </button>
        </div>
      </div>

      <div className="db-content">
        {/* Tables View */}
        {activeView === 'tables' && (
          <div className="tables-layout">
            {/* Sidebar: Table List */}
            <aside className="tables-sidebar">
              <h4>Tables ({tablesData.tables.length})</h4>
              <ul className="table-list">
                {tablesData.tables.map((table) => (
                  <li
                    key={table.name}
                    className={selectedTable === table.name ? 'active' : ''}
                    onClick={() => {
                      setSelectedTable(table.name);
                      setCurrentPage(0);
                    }}
                  >
                    <span className="table-name">{table.name}</span>
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
                    <h4>{selectedTable}</h4>
                    {tableData && (
                      <span className="row-info">
                        {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, tableData.total)} of {tableData.total}
                      </span>
                    )}
                  </div>

                  {dataLoading ? (
                    <div className="loading">Loading...</div>
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
                                {Object.values(row).map((val: any, colIdx) => (
                                  <td key={colIdx}>
                                    {val === null ? (
                                      <span className="null-value">NULL</span>
                                    ) : typeof val === 'object' ? (
                                      JSON.stringify(val)
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
                          onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                          disabled={currentPage === 0}
                        >
                          Previous
                        </button>
                        <span>Page {currentPage + 1}</span>
                        <button
                          onClick={() => setCurrentPage(p => p + 1)}
                          disabled={!tableData.hasMore}
                        >
                          Next
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">No data</div>
                  )}
                </>
              ) : (
                <div className="select-table">
                  <p>← Select a table to view its contents</p>
                </div>
              )}
            </main>
          </div>
        )}

        {/* Query View */}
        {activeView === 'query' && (
          <div className="query-layout">
            <div className="query-editor">
              <h4>Custom SQL Query</h4>
              <p className="query-hint">Only SELECT queries are allowed for safety.</p>
              
              <textarea
                className="query-input"
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="SELECT * FROM files WHERE size > 1000 LIMIT 10;"
                rows={6}
              />
              
              <button 
                className="run-query-btn"
                onClick={handleRunQuery}
                disabled={queryLoading || !customQuery.trim()}
              >
                {queryLoading ? 'Running...' : '▶ Run Query'}
              </button>
            </div>

            {queryResults && (
              <div className="query-results">
                {queryResults.success ? (
                  <>
                    <div className="results-header">
                      ✅ {queryResults.rowCount} rows returned
                    </div>
                    {queryResults.results.length > 0 && (
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
                            {queryResults.results.map((row: any, idx: number) => (
                              <tr key={idx}>
                                {Object.values(row).map((val: any, colIdx) => (
                                  <td key={colIdx}>
                                    {val === null ? (
                                      <span className="null-value">NULL</span>
                                    ) : typeof val === 'object' ? (
                                      JSON.stringify(val)
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
                  <div className="error-message">
                    ❌ {queryResults.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        .raiken-db-viewer {
          display: flex;
          flex-direction: column;
          height: 100%;
          flex: 1;
          background: #0a0a0a;
          color: #e5e7eb;
          overflow: hidden;
        }

        .raiken-db-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.5rem;
          background: #1a1a1a;
          border-bottom: 1px solid #2a2a2a;
          flex-shrink: 0;
        }

        .raiken-db-viewer .header-left {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .raiken-db-viewer .close-btn {
          width: 2rem;
          height: 2rem;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #2a2a2a;
          border: none;
          border-radius: 6px;
          color: #e5e7eb;
          font-size: 1.25rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .raiken-db-viewer .close-btn:hover {
          background: #3a3a3a;
        }

        .raiken-db-header h3 {
          font-size: 1.125rem;
          margin: 0;
          font-weight: 600;
          color: #e5e7eb;
        }

        .raiken-db-viewer .view-switcher {
          display: flex;
          gap: 0.5rem;
          background: #0a0a0a;
          padding: 0.25rem;
          border-radius: 8px;
        }

        .raiken-db-viewer .view-switcher button {
          padding: 0.5rem 1.25rem;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: #888;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .raiken-db-viewer .view-switcher button:hover {
          color: #e5e7eb;
        }

        .raiken-db-viewer .view-switcher button.active {
          background: #7C3AED;
          color: #ffffff;
        }

        .raiken-db-viewer .db-content {
          flex: 1;
          overflow: hidden;
          background: #0a0a0a;
        }

        .raiken-db-viewer .tables-layout {
          display: grid;
          grid-template-columns: 240px 1fr;
          height: 100%;
        }

        .raiken-db-viewer .tables-sidebar {
          background: #1a1a1a;
          border-right: 1px solid #2a2a2a;
          padding: 1rem;
          overflow-y: auto;
        }

        .raiken-db-viewer .tables-sidebar h4 {
          font-size: 0.75rem;
          color: #888;
          text-transform: uppercase;
          margin: 0 0 0.75rem 0;
          font-weight: 600;
          letter-spacing: 0.5px;
        }

        .raiken-db-viewer .table-list {
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
          padding: 0;
          margin: 0;
        }

        .raiken-db-viewer .table-list li {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.625rem 0.75rem;
          background: #0a0a0a;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
          color: #e5e7eb;
        }

        .raiken-db-viewer .table-list li:hover {
          background: #2a2a2a;
        }

        .raiken-db-viewer .table-list li.active {
          background: #7C3AED;
          color: #ffffff;
        }

        .raiken-db-viewer .table-name {
          font-weight: 500;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .table-count {
          font-size: 0.75rem;
          opacity: 0.7;
          background: rgba(255, 255, 255, 0.1);
          padding: 0.125rem 0.5rem;
          border-radius: 10px;
        }

        .raiken-db-viewer .table-list li.active .table-count {
          background: rgba(255, 255, 255, 0.2);
        }

        .raiken-db-viewer .table-content {
          padding: 1.5rem;
          overflow-y: auto;
          background: #0a0a0a;
        }

        .raiken-db-viewer .table-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .raiken-db-viewer .table-header h4 {
          font-size: 1rem;
          color: #7C3AED;
          margin: 0;
          font-weight: 600;
        }

        .raiken-db-viewer .row-info {
          color: #888;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .table-wrapper {
          overflow-x: auto;
          overflow-y: auto;
          max-height: calc(100vh - 400px);
          background: #1a1a1a;
          border-radius: 8px;
          border: 1px solid #2a2a2a;
        }

        .raiken-db-viewer .data-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.8125rem;
        }

        .raiken-db-viewer .data-table th {
          background: #2a2a2a;
          padding: 0.625rem 0.875rem;
          text-align: left;
          font-weight: 600;
          color: #7C3AED;
          position: sticky;
          top: 0;
          z-index: 10;
          border-bottom: 1px solid #3a3a3a;
        }

        .raiken-db-viewer .data-table td {
          padding: 0.625rem 0.875rem;
          border-bottom: 1px solid #2a2a2a;
          max-width: 400px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #e5e7eb;
        }

        .raiken-db-viewer .data-table tbody tr:hover {
          background: #2a2a2a;
        }

        .raiken-db-viewer .null-value {
          color: #666;
          font-style: italic;
        }

        .raiken-db-viewer .pagination {
          display: flex;
          gap: 1rem;
          align-items: center;
          justify-content: center;
          padding-top: 1rem;
        }

        .raiken-db-viewer .pagination button {
          padding: 0.5rem 1.25rem;
          background: #7C3AED;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
          font-weight: 500;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .pagination button:hover:not(:disabled) {
          background: #6D28D9;
        }

        .raiken-db-viewer .pagination button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .raiken-db-viewer .pagination span {
          color: #888;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .query-layout {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          overflow-y: auto;
          height: 100%;
          background: #0a0a0a;
        }

        .raiken-db-viewer .query-editor h4 {
          font-size: 1rem;
          margin: 0 0 0.5rem 0;
          font-weight: 600;
          color: #e5e7eb;
        }

        .raiken-db-viewer .query-hint {
          color: #888;
          font-size: 0.8125rem;
          margin-bottom: 0.75rem;
        }

        .raiken-db-viewer .query-input {
          width: 100%;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          padding: 0.875rem;
          color: #e5e7eb;
          font-family: 'Monaco', 'Courier New', monospace;
          font-size: 0.8125rem;
          resize: vertical;
          margin-bottom: 0.75rem;
        }

        .raiken-db-viewer .query-input:focus {
          outline: none;
          border-color: #7C3AED;
          box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.2);
        }

        .raiken-db-viewer .run-query-btn {
          padding: 0.625rem 1.5rem;
          background: #10B981;
          color: white;
          border: none;
          border-radius: 6px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .run-query-btn:hover:not(:disabled) {
          background: #059669;
        }

        .raiken-db-viewer .run-query-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .raiken-db-viewer .query-results {
          margin-top: 0.5rem;
        }

        .raiken-db-viewer .results-header {
          color: #10B981;
          font-weight: 600;
          margin-bottom: 1rem;
          padding: 0.75rem;
          background: rgba(16, 185, 129, 0.1);
          border-radius: 6px;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .error-message {
          color: #EF4444;
          font-weight: 600;
          padding: 0.75rem;
          background: rgba(239, 68, 68, 0.1);
          border-radius: 6px;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .loading {
          text-align: center;
          padding: 3rem;
          color: #888;
          font-size: 0.875rem;
        }

        .raiken-db-viewer .empty-state {
          text-align: center;
          padding: 3rem 1.5rem;
          color: #888;
        }

        .raiken-db-viewer .empty-icon {
          font-size: 3rem;
          margin-bottom: 0.75rem;
          opacity: 0.5;
        }

        .raiken-db-viewer .empty-state h3 {
          font-size: 1.125rem;
          margin-bottom: 0.5rem;
          color: #e5e7eb;
        }

        .raiken-db-viewer .select-table {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: #888;
          font-size: 1rem;
        }
      `}</style>
    </div>
  );
}

