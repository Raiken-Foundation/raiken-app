export function ConnectionNotReady({ checks }: { checks?: Record<string, string> }) {
    const blocking = checks
        ? Object.entries(checks)
              .filter(([, v]) => v === "invalid" || v === "unavailable")
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")
        : "";
    return (
        <div className="connection-not-ready-overlay">
            <div className="connection-not-ready-card">
                <header className="connection-not-ready-head">
                    <span className="q-sev q-sev--fail">NOT READY</span>
                    <span>raiken/server</span>
                </header>
                <div className="connection-not-ready-body">
                    <p className="connection-not-ready-msg">
                        backend is running but required configuration or storage is not ready.
                        {blocking ? ` (${blocking})` : ""}
                    </p>
                    <p className="connection-not-ready-hint">
                        fix invalid config or database issues, then reload.
                    </p>
                    <button
                        type="button"
                        className="q-btn q-btn--primary"
                        onClick={() => window.location.reload()}
                    >
                        retry
                    </button>
                </div>
            </div>
            <style>{`
                .connection-not-ready-overlay {
                    position: fixed;
                    inset: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.85);
                    z-index: 9998;
                    backdrop-filter: blur(4px);
                }
                .connection-not-ready-card {
                    display: flex;
                    flex-direction: column;
                    background: var(--bg-elev);
                    border: 1px solid var(--hair);
                    width: 420px;
                    max-width: calc(100vw - 2rem);
                    font-family: var(--mono);
                }
                .connection-not-ready-head {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 0.75rem;
                    background: var(--bg-bar);
                    border-bottom: 1px solid var(--hair);
                    font-size: 11px;
                    color: var(--ink-dim);
                }
                .connection-not-ready-body {
                    padding: 1.25rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.875rem;
                }
                .connection-not-ready-msg,
                .connection-not-ready-hint {
                    margin: 0;
                    color: var(--ink);
                    font-size: 12.5px;
                    line-height: 1.55;
                }
                .connection-not-ready-hint {
                    color: var(--ink-dim);
                }
            `}</style>
        </div>
    );
}

export function ConnectionDegraded({ checks }: { checks?: Record<string, string> }) {
    const hints = checks
        ? Object.entries(checks)
              .filter(([, v]) => v !== "ok" && v !== "idle" && v !== "not_configured")
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")
        : "";
    return (
        <output className="connection-degraded-banner" aria-live="polite">
            <span className="q-sev q-sev--warn">DEGRADED</span>
            <span>
                backend is up but some capabilities are limited
                {hints ? ` (${hints})` : ""}
            </span>
            <style>{`
                .connection-degraded-banner {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.375rem 0.75rem;
                    background: color-mix(in srgb, var(--warn) 12%, var(--bg-bar));
                    border-bottom: 1px solid var(--hair);
                    font-family: var(--mono);
                    font-size: 11px;
                    color: var(--ink-dim);
                }
            `}</style>
        </output>
    );
}

export function ConnectionError() {
    return (
        <div className="connection-error-overlay">
            <div className="connection-error-card">
                <header className="connection-error-head">
                    <span className="q-sev q-sev--fail">OFFLINE</span>
                    <span>raiken/server</span>
                </header>
                <div className="connection-error-body">
                    <p className="connection-error-msg">
                        backend not responding. start it from a terminal:
                    </p>
                    <pre className="connection-error-cmd">
                        <span className="connection-error-prompt">$</span> raiken start
                    </pre>
                    <button
                        type="button"
                        className="q-btn q-btn--primary"
                        onClick={() => window.location.reload()}
                    >
                        retry
                    </button>
                </div>
            </div>
            <style>{`
                .connection-error-overlay {
                    position: fixed;
                    inset: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.85);
                    z-index: 9999;
                    backdrop-filter: blur(4px);
                }
                .connection-error-card {
                    display: flex;
                    flex-direction: column;
                    background: var(--bg-elev);
                    border: 1px solid var(--hair);
                    width: 420px;
                    max-width: calc(100vw - 2rem);
                    font-family: var(--mono);
                }
                .connection-error-head {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 0.75rem;
                    background: var(--bg-bar);
                    border-bottom: 1px solid var(--hair);
                    font-size: 11px;
                    color: var(--ink-dim);
                }
                .connection-error-body {
                    padding: 1.25rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.875rem;
                }
                .connection-error-msg {
                    margin: 0;
                    color: var(--ink);
                    font-size: 12.5px;
                    line-height: 1.55;
                }
                .connection-error-cmd {
                    margin: 0;
                    padding: 0.5rem 0.75rem;
                    background: var(--bg);
                    border: 1px solid var(--hair);
                    color: var(--ink);
                    font-family: var(--mono);
                    font-size: 12.5px;
                }
                .connection-error-prompt {
                    color: var(--accent);
                    margin-right: 0.4375rem;
                }
            `}</style>
        </div>
    );
}

/** Derive dashboard connection UI flags from health query state. */
export function deriveConnectionFlags(health: { isError: boolean; data?: { status?: string } }): {
    isBackendDown: boolean;
    isBackendNotReady: boolean;
    isBackendDegraded: boolean;
} {
    const isBackendDown = health.isError;
    const healthStatus = health.data?.status;
    return {
        isBackendDown,
        isBackendNotReady: !isBackendDown && healthStatus === "not_ready",
        isBackendDegraded: !isBackendDown && healthStatus === "degraded",
    };
}
