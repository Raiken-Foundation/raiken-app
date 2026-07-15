import { useMemo, useState } from "react";

export interface TestFileItem {
    id: string;
    name: string;
    path: string;
    directory: string;
    status?: "fresh" | "stale" | "broken";
}

interface FilesPanelProps {
    files: TestFileItem[];
    activeFilePath?: string;
    onFileSelect?: (filePath: string) => void;
    /**
     * Re-fetch the file list from disk. The button is hidden when omitted so
     * callers that have no refresh story (e.g. tests, storybook) don't render
     * a no-op control.
     */
    onRefresh?: () => void;
    /** Show a spinning state on the refresh button while a fetch is in flight. */
    isRefreshing?: boolean;
}

const STATUS_META = {
    fresh: { label: "passing" },
    stale: { label: "stale" },
    broken: { label: "failing" },
} as const;

function StatusDot({ status }: { status: TestFileItem["status"] }) {
    if (!status) return null;
    return (
        <span
            className={`fp-dot fp-dot--${status}`}
            role="img"
            aria-label={STATUS_META[status].label}
        />
    );
}

export function FilesPanel({
    files,
    activeFilePath,
    onFileSelect,
    onRefresh,
    isRefreshing = false,
}: FilesPanelProps) {
    const [filter, setFilter] = useState("");
    const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

    const filtered = useMemo(() => {
        if (!filter) return files;
        const q = filter.toLowerCase();
        return files.filter(
            (f) => f.name.toLowerCase().includes(q) || f.directory.toLowerCase().includes(q),
        );
    }, [files, filter]);

    const grouped = useMemo(() => {
        const map: Record<string, TestFileItem[]> = {};
        for (const f of filtered) {
            if (!map[f.directory]) {
                map[f.directory] = [];
            }
            map[f.directory].push(f);
        }
        return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
    }, [filtered]);

    const counts = useMemo(
        () => ({
            fresh: files.filter((f) => f.status === "fresh").length,
            stale: files.filter((f) => f.status === "stale").length,
            broken: files.filter((f) => f.status === "broken").length,
        }),
        [files],
    );

    const toggleDir = (dir: string) =>
        setCollapsedDirs((prev) => {
            const next = new Set(prev);
            next.has(dir) ? next.delete(dir) : next.add(dir);
            return next;
        });

    const refreshButton = onRefresh ? (
        <button
            type="button"
            className={`fp-refresh ${isRefreshing ? "spinning" : ""}`}
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="refresh file list"
            title="refresh file list"
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M21 12a9 9 0 1 1-3.51-7.13" />
                <polyline points="21 3 21 9 15 9" />
            </svg>
        </button>
    ) : null;

    if (files.length === 0) {
        return (
            <div className="fp">
                <div className="fp-header">
                    <span className="fp-brand-dot" aria-hidden="true" />
                    <span className="fp-title">files</span>
                    <span className="fp-spacer" />
                    {refreshButton}
                </div>
                <div className="fp-empty">
                    <p className="fp-empty-title">no test files yet</p>
                    <p className="fp-empty-hint">use the agent to draft your first spec.</p>
                </div>
                <style>{STYLES}</style>
            </div>
        );
    }

    return (
        <div className="fp">
            <div className="fp-header">
                <span className="fp-brand-dot" aria-hidden="true" />
                <span className="fp-title">files</span>
                <span className="fp-spacer" />
                <span className="fp-count">{files.length}</span>
                {refreshButton}
            </div>

            <div className="fp-search-wrap">
                <span className="fp-search-prompt" aria-hidden="true">
                    /
                </span>
                <input
                    className="fp-search"
                    type="text"
                    placeholder="filter…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                    <button
                        type="button"
                        className="fp-search-clear"
                        onClick={() => setFilter("")}
                        aria-label="clear filter"
                        title="clear filter"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                        >
                            <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                )}
            </div>

            <div className="fp-list">
                {grouped.map(([dir, dirFiles]) => {
                    const isCollapsed = collapsedDirs.has(dir);
                    return (
                        <div key={dir} className="fp-dir">
                            <button
                                type="button"
                                className="fp-dir-header"
                                onClick={() => toggleDir(dir)}
                                aria-expanded={!isCollapsed}
                            >
                                <span
                                    className={`fp-chevron ${isCollapsed ? "collapsed" : ""}`}
                                    aria-hidden="true"
                                >
                                    ▾
                                </span>
                                <span className="fp-dir-name">{dir || "."}</span>
                                <span className="fp-dir-count">{dirFiles.length}</span>
                            </button>
                            {!isCollapsed &&
                                dirFiles.map((file) => (
                                    <button
                                        type="button"
                                        key={file.path}
                                        className={`fp-file ${activeFilePath === file.path ? "selected" : ""}`}
                                        onClick={() => onFileSelect?.(file.path)}
                                        title={file.path}
                                    >
                                        <StatusDot status={file.status} />
                                        <span className="fp-file-name">{file.name}</span>
                                    </button>
                                ))}
                        </div>
                    );
                })}

                {filtered.length === 0 && filter && (
                    <div className="fp-no-results">no files match &ldquo;{filter}&rdquo;</div>
                )}
            </div>

            <div className="fp-status-bar">
                {(["fresh", "stale", "broken"] as const).map((s) => (
                    <span key={s} className={`fp-stat fp-stat--${s}`}>
                        <span className="fp-stat-dot" />
                        <span className="fp-stat-val">{counts[s]}</span>
                        <span className="fp-stat-label">{STATUS_META[s].label}</span>
                    </span>
                ))}
            </div>

            <style>{STYLES}</style>
        </div>
    );
}

const STYLES = `
    .fp {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        background: var(--bg);
        font-family: var(--mono);
        color: var(--ink);
    }

    .fp-header {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        padding: 0 0.75rem;
        height: 28px;
        background: var(--bg-bar);
        border-bottom: 1px solid var(--hair);
        font-family: var(--mono);
        font-size: 11px;
        color: var(--ink-dim);
        flex-shrink: 0;
    }
    .fp-brand-dot {
        width: 6px;
        height: 6px;
        background: var(--accent);
        flex-shrink: 0;
    }
    .fp-title {
        color: var(--accent);
        font-family: var(--mono);
        font-size: 11px;
    }
    .fp-spacer { flex: 1; }
    .fp-count {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--ink-faint);
        font-variant-numeric: tabular-nums;
    }

    .fp-refresh {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        margin-left: 0.375rem;
        padding: 0;
        background: transparent;
        border: 0;
        color: var(--ink-faint);
        cursor: pointer;
        transition: color 0.1s;
    }
    .fp-refresh:hover:not(:disabled) {
        color: var(--ink);
    }
    .fp-refresh:disabled {
        cursor: progress;
    }
    .fp-refresh:focus-visible {
        outline: 1px solid var(--accent-dim);
        outline-offset: 1px;
    }
    .fp-refresh svg {
        width: 12px;
        height: 12px;
    }
    .fp-refresh.spinning svg {
        animation: fp-spin 0.7s linear infinite;
    }
    @keyframes fp-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }

    .fp-search-wrap {
        position: relative;
        display: flex;
        align-items: center;
        padding: 0;
        margin: 0.5rem 0.625rem;
        background: var(--bg-elev);
        border: 1px solid var(--hair);
    }
    .fp-search-wrap:focus-within {
        border-color: var(--accent-dim);
    }

    .fp-search-prompt {
        padding: 0 0.5rem;
        color: var(--accent);
        font-family: var(--mono);
        font-size: 12px;
        user-select: none;
    }

    .fp-search {
        flex: 1;
        padding: 0.3125rem 0.4375rem 0.3125rem 0;
        background: transparent;
        border: 0;
        color: var(--ink);
        font-family: var(--mono);
        font-size: 12px;
        outline: none;
    }
    .fp-search::placeholder {
        color: var(--ink-faint);
    }

    .fp-search-clear {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin-right: 2px;
        padding: 0;
        background: transparent;
        border: 0;
        color: var(--ink-faint);
        cursor: pointer;
    }
    .fp-search-clear:hover {
        color: var(--ink);
    }
    .fp-search-clear svg {
        width: 10px;
        height: 10px;
    }

    .fp-list {
        flex: 1;
        overflow-y: auto;
        padding: 0.125rem 0 0.5rem;
    }

    .fp-dir + .fp-dir {
        margin-top: 0;
    }

    .fp-dir-header {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        width: 100%;
        padding: 0.3125rem 0.75rem;
        background: transparent;
        border: 0;
        color: var(--ink-faint);
        font-family: var(--mono);
        font-size: 11px;
        cursor: pointer;
        text-align: left;
        transition: color 0.1s;
    }
    .fp-dir-header:hover {
        color: var(--ink-dim);
    }
    .fp-dir-header:focus-visible {
        outline: 0;
        background: var(--bg-hover);
    }

    .fp-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 10px;
        color: var(--ink-mute);
        font-size: 10px;
        transition: transform 0.15s;
    }
    .fp-chevron.collapsed {
        transform: rotate(-90deg);
    }

    .fp-dir-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ink-dim);
    }

    .fp-dir-count {
        font-family: var(--mono);
        font-size: 10.5px;
        color: var(--ink-mute);
        font-variant-numeric: tabular-nums;
    }

    .fp-file {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.25rem 0.75rem 0.25rem 1.75rem;
        background: transparent;
        border: 0;
        color: var(--ink-dim);
        font-family: var(--mono);
        font-size: 12px;
        cursor: pointer;
        text-align: left;
        transition: color 0.1s, background 0.1s;
    }
    .fp-file:hover {
        background: var(--bg-hover);
        color: var(--ink);
    }
    .fp-file.selected {
        background: var(--accent-soft);
        color: var(--ink);
    }
    .fp-file.selected::before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--accent);
    }

    .fp-file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .fp-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .fp-dot--fresh { background: var(--pass); }
    .fp-dot--stale { background: var(--warn); }
    .fp-dot--broken { background: var(--fail); }

    .fp-status-bar {
        display: flex;
        align-items: baseline;
        gap: 0;
        border-top: 1px solid var(--hair);
        background: var(--bg-bar);
        font-family: var(--mono);
        font-size: 11px;
        flex-shrink: 0;
    }
    .fp-stat {
        display: inline-flex;
        align-items: baseline;
        gap: 0.375rem;
        padding: 0.375rem 0.625rem;
        border-right: 1px solid var(--hair);
        font-variant-numeric: tabular-nums;
    }
    .fp-stat:last-child { border-right: 0; }
    .fp-stat-dot {
        width: 6px;
        height: 6px;
        align-self: center;
    }
    .fp-stat-val {
        color: var(--ink);
    }
    .fp-stat-label {
        color: var(--ink-faint);
    }
    .fp-stat--fresh .fp-stat-dot { background: var(--pass); }
    .fp-stat--fresh .fp-stat-val { color: var(--pass); }
    .fp-stat--stale .fp-stat-dot { background: var(--warn); }
    .fp-stat--stale .fp-stat-val { color: var(--warn); }
    .fp-stat--broken .fp-stat-dot { background: var(--fail); }
    .fp-stat--broken .fp-stat-val { color: var(--fail); }

    .fp-no-results {
        padding: 1rem;
        text-align: center;
        color: var(--ink-faint);
        font-family: var(--mono);
        font-size: 11.5px;
    }

    .fp-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        padding: 2rem 1rem;
        text-align: center;
        font-family: var(--mono);
    }
    .fp-empty-title {
        margin: 0;
        font-size: 12.5px;
        color: var(--ink-dim);
    }
    .fp-empty-hint {
        margin: 0;
        font-size: 11.5px;
        color: var(--ink-faint);
    }
`;
