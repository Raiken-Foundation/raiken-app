export function SettingsLoadingState() {
    return (
        <div className="settings-loading">
            <div className="loader-spinner" />
            <span>Loading configuration...</span>
        </div>
    );
}

export function SettingsErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="settings-loading">
            <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fail)"
                strokeWidth="1.5"
                className="settings-error-icon"
            >
                <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Failed to load configuration: {message}</span>
            <button type="button" className="settings-retry-btn" onClick={onRetry}>
                retry
            </button>
        </div>
    );
}
