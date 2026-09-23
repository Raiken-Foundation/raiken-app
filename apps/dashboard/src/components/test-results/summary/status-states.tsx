export function RunningState() {
    return (
        <div className="running-state">
            <div className="running-spinner" />
            <span>Running tests...</span>
            <span className="running-hint">This may take a few moments</span>
        </div>
    );
}

export function EmptyState() {
    return (
        <div className="empty-state">
            <svg aria-hidden="true" className="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M5 3l14 9-14 9V3z" />
            </svg>
            <h3>Ready to Run Tests</h3>
            <p>Select a test file from the editor and click "Run Tests" to execute it.</p>
            <div className="empty-tips">
                <h4>Test Execution Tips:</h4>
                <ul>
                    <li>Tests run against your application's dev server</li>
                    <li>Make sure your dev server is running before executing tests</li>
                    <li>Failed tests will show error details and screenshots</li>
                </ul>
            </div>
        </div>
    );
}
