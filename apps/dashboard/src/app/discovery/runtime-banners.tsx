interface RuntimeBannersProps {
    isRunning: boolean;
    progressPct: number | null;
    pagesDiscovered: number | null | undefined;
    maxPages: number | null | undefined;
    showCompletion: boolean;
    completionReason: string | undefined;
    onDismissCompletion: () => void;
    showPausedEmptyBlockers: boolean;
}

export function RuntimeBanners({
    isRunning,
    progressPct,
    pagesDiscovered,
    maxPages,
    showCompletion,
    completionReason,
    onDismissCompletion,
    showPausedEmptyBlockers,
}: RuntimeBannersProps) {
    return (
        <>
            {isRunning && progressPct !== null && (
                <div className="progress-bar-wrap">
                    <div className="progress-bar" style={{ width: `${progressPct}%` }} />
                    <span className="progress-label">
                        {pagesDiscovered ?? 0} / {maxPages} pages ({progressPct}%)
                    </span>
                </div>
            )}
            {showCompletion && (
                <div className="banner banner-success">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
                        <path d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Discovery complete &mdash; {completionReason}</span>
                    <button
                        type="button"
                        className="banner-close"
                        onClick={onDismissCompletion}
                        aria-label="Dismiss"
                    >
                        &times;
                    </button>
                </div>
            )}
            {showPausedEmptyBlockers && (
                <div className="banner banner-warn">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
                        <path d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>Discovery paused &mdash; waiting to continue</span>
                </div>
            )}
        </>
    );
}
