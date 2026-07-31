import { useMemo, useRef } from "react";
import { safeHttpUrl } from "./helpers";
import type { DiscoveryFormState } from "./types";

export interface RunDiscoveryFormProps {
    form: DiscoveryFormState;
    detectedBaseURL: string | null;
    isPaused: boolean;
    isRunning: boolean;
    canStart: boolean;
    canContinue: boolean;
    requiresAuth: boolean;
    isActionPending: boolean;
    startPending: boolean;
    continuePending: boolean;
    pausePending: boolean;
    abortPending: boolean;
    clearPending: boolean;
    dismissErrorPending: boolean;
    authAssistFetching: boolean;
    actionError: string | null;
    queryError: string | null;
    showDismissError: boolean;
    onFormChange: (updater: (prev: DiscoveryFormState) => DiscoveryFormState) => void;
    onRemoveExcludePattern: (pattern: string) => void;
    onExcludeKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onStart: () => void;
    onContinue: () => void;
    onPause: () => void;
    onAbort: () => void;
    onClear: () => void;
    onDismissError: () => void;
    onAuthAssist: () => void;
}

export function RunDiscoveryForm({
    form,
    detectedBaseURL,
    isPaused,
    isRunning,
    canStart,
    canContinue,
    requiresAuth,
    isActionPending,
    startPending,
    continuePending,
    pausePending,
    abortPending,
    clearPending,
    dismissErrorPending,
    authAssistFetching,
    actionError,
    queryError,
    showDismissError,
    onFormChange,
    onRemoveExcludePattern,
    onExcludeKeyDown,
    onStart,
    onContinue,
    onPause,
    onAbort,
    onClear,
    onDismissError,
    onAuthAssist,
}: RunDiscoveryFormProps) {
    const excludeInputRef = useRef<HTMLInputElement>(null);
    const formUrlForLink = useMemo(() => safeHttpUrl(form.url), [form.url]);

    return (
        <section className="card">
            <h2 className="card-title">Run Discovery</h2>

            <label className="field">
                <span className="field-label">Start URL</span>
                <div className="url-row">
                    <input
                        value={form.url}
                        onChange={(e) => onFormChange((prev) => ({ ...prev, url: e.target.value }))}
                        placeholder={detectedBaseURL ?? "http://localhost:3000"}
                    />
                    {formUrlForLink && (
                        <a
                            className="url-open"
                            href={formUrlForLink}
                            target="_blank"
                            rel="noreferrer"
                            title="Open in browser"
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                            >
                                <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            <span className="sr-only">Open in browser</span>
                        </a>
                    )}
                </div>
                {detectedBaseURL && form.url === detectedBaseURL && (
                    <span className="field-hint">
                        Auto-detected from <code>playwright.config.ts</code> ·{" "}
                        <code>use.baseURL</code>
                    </span>
                )}
            </label>

            <div className="field-row-3">
                <label className="field">
                    <span className="field-label">Max Pages</span>
                    <input
                        value={form.maxPages}
                        onChange={(e) =>
                            onFormChange((prev) => ({ ...prev, maxPages: e.target.value }))
                        }
                    />
                </label>
                <label className="field">
                    <span className="field-label">Max Depth</span>
                    <input
                        value={form.maxDepth}
                        onChange={(e) =>
                            onFormChange((prev) => ({ ...prev, maxDepth: e.target.value }))
                        }
                    />
                </label>
                <label className="field">
                    <span className="field-label">Timeout (ms)</span>
                    <input
                        value={form.timeout}
                        onChange={(e) =>
                            onFormChange((prev) => ({ ...prev, timeout: e.target.value }))
                        }
                    />
                </label>
            </div>

            <div className="options-row">
                <label className="toggle">
                    <span className={`toggle-track ${form.skipAuth ? "on" : ""}`}>
                        <span className="toggle-thumb" />
                    </span>
                    <input
                        type="checkbox"
                        checked={form.skipAuth}
                        onChange={(e) =>
                            onFormChange((prev) => ({ ...prev, skipAuth: e.target.checked }))
                        }
                        className="sr-only"
                    />
                    <span className="toggle-label">Skip auth pause</span>
                </label>
            </div>

            <div className="exclude-section">
                <span className="field-label">Exclude patterns</span>
                <div className="tags-wrap">
                    {form.excludePatterns.map((p) => (
                        <span key={p} className="tag">
                            {p}
                            <button
                                type="button"
                                className="tag-x"
                                onClick={() => onRemoveExcludePattern(p)}
                                aria-label={`Remove ${p}`}
                            >
                                &times;
                            </button>
                        </span>
                    ))}
                    <input
                        ref={excludeInputRef}
                        className="tag-input"
                        placeholder="Add pattern…"
                        onKeyDown={onExcludeKeyDown}
                    />
                </div>
            </div>

            <div className="action-bar">
                <button
                    type="button"
                    className="btn primary"
                    onClick={onStart}
                    disabled={!canStart}
                    title={
                        isPaused
                            ? "Discovery is paused. Resolve the blocker and Continue, or Clear before starting a new crawl."
                            : undefined
                    }
                >
                    {startPending ? "Starting…" : isRunning ? "Running…" : "Start Discovery"}
                </button>
                {isRunning && (
                    <button
                        type="button"
                        className="btn"
                        onClick={onPause}
                        disabled={pausePending}
                        title="Pause the running crawl. You can inspect blockers, drive a browser, or resume from the dashboard."
                    >
                        {pausePending ? "Pausing…" : "Pause"}
                    </button>
                )}
                {isRunning && (
                    <button
                        type="button"
                        className="btn danger"
                        onClick={onAbort}
                        disabled={abortPending}
                        title="Stop the running crawl immediately."
                    >
                        {abortPending ? "Stopping…" : "Stop"}
                    </button>
                )}
                {canContinue && (
                    <button
                        type="button"
                        className="btn"
                        onClick={onContinue}
                        disabled={continuePending}
                    >
                        {continuePending ? "Continuing…" : "Continue"}
                    </button>
                )}
                {requiresAuth && (
                    <button
                        type="button"
                        className="btn"
                        onClick={onAuthAssist}
                        disabled={authAssistFetching}
                    >
                        {authAssistFetching ? "Loading…" : "Auth Assist"}
                    </button>
                )}
                <button
                    type="button"
                    className="btn danger"
                    onClick={onClear}
                    disabled={isActionPending}
                >
                    {clearPending ? "Clearing…" : "Clear Data"}
                </button>
            </div>

            {actionError && (
                <div className="error-banner">
                    <span>
                        <strong>Error:</strong> {actionError}
                    </span>
                    {showDismissError && (
                        <button
                            type="button"
                            className="btn"
                            onClick={onDismissError}
                            disabled={dismissErrorPending}
                            title="Clear the error and return discovery to idle."
                        >
                            {dismissErrorPending ? "Dismissing…" : "Dismiss"}
                        </button>
                    )}
                </div>
            )}
            {queryError && !actionError && (
                <div className="error-banner">
                    <strong>Data Error:</strong> {queryError}
                </div>
            )}
        </section>
    );
}
