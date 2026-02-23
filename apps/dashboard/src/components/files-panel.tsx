import { useState, useMemo } from "react";

export interface TestFileItem {
    id: string;
    name: string;
    path: string;
    directory: string;
    status: "fresh" | "stale" | "broken";
}

interface FilesPanelProps {
    files: TestFileItem[];
    activeFilePath?: string;
    onFileSelect?: (filePath: string) => void;
}

const STATUS_META = {
    fresh: { label: "Passing", color: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.2)" },
    stale: { label: "Stale", color: "#eab308", bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.2)" },
    broken: { label: "Failing", color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.2)" },
} as const;

function StatusDot({ status }: { status: TestFileItem["status"] }) {
    return <span className={`fp-dot fp-dot--${status}`} aria-label={STATUS_META[status].label} />;
}

export function FilesPanel({ files, activeFilePath, onFileSelect }: FilesPanelProps) {
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
            (map[f.directory] ??= []).push(f);
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

    if (files.length === 0) {
        return (
            <div className="fp">
                <div className="fp-header">
                    <span className="fp-title">Test Files</span>
                </div>
                <div className="fp-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="fp-empty-title">No test files yet</p>
                    <p className="fp-empty-hint">Use the AI chat to generate your first test</p>
                </div>
                <style>{STYLES}</style>
            </div>
        );
    }

    return (
        <div className="fp">
            <div className="fp-header">
                <span className="fp-title">Test Files</span>
                <span className="fp-count">{files.length}</span>
            </div>

            <div className="fp-search-wrap">
                <svg className="fp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                    className="fp-search"
                    type="text"
                    placeholder="Filter files..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                    <button type="button" className="fp-search-clear" onClick={() => setFilter("")} aria-label="Clear filter">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
                            <button type="button" className="fp-dir-header" onClick={() => toggleDir(dir)}>
                                <svg
                                    className={`fp-chevron ${isCollapsed ? "collapsed" : ""}`}
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    aria-hidden="true"
                                >
                                    <path d="M19 9l-7 7-7-7" />
                                </svg>
                                <svg className="fp-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                </svg>
                                <span className="fp-dir-name">{dir}</span>
                                <span className="fp-dir-count">{dirFiles.length}</span>
                            </button>
                            {!isCollapsed &&
                                dirFiles.map((file) => (
                                    <button
                                        type="button"
                                        key={file.path}
                                        className={`fp-file ${activeFilePath === file.path ? "selected" : ""}`}
                                        onClick={() => onFileSelect?.(file.path)}
                                    >
                                        <StatusDot status={file.status} />
                                        <span className="fp-file-name">{file.name}</span>
                                    </button>
                                ))}
                        </div>
                    );
                })}

                {filtered.length === 0 && filter && (
                    <div className="fp-no-results">No files match &ldquo;{filter}&rdquo;</div>
                )}
            </div>

            <div className="fp-status-bar">
                {(["fresh", "stale", "broken"] as const).map((s) => (
                    <span key={s} className={`fp-stat fp-stat--${s}`}>
                        <span className="fp-stat-dot" />
                        {counts[s]}
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
    }

    .fp-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.875rem 1rem;
        border-bottom: 1px solid #1f1f1f;
    }

    .fp-title {
        font-size: 0.8125rem;
        font-weight: 600;
        color: #e5e7eb;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .fp-count {
        margin-left: auto;
        font-size: 0.6875rem;
        font-weight: 500;
        color: #9ca3af;
        background: #1f1f1f;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
    }

    .fp-search-wrap {
        position: relative;
        padding: 0.5rem 0.75rem;
    }

    .fp-search-icon {
        position: absolute;
        left: 1.125rem;
        top: 50%;
        transform: translateY(-50%);
        width: 0.875rem;
        height: 0.875rem;
        color: #6b7280;
        pointer-events: none;
    }

    .fp-search {
        width: 100%;
        padding: 0.375rem 1.75rem 0.375rem 1.75rem;
        background: #141414;
        border: 1px solid #2a2a2a;
        border-radius: 6px;
        color: #e5e7eb;
        font-size: 0.8125rem;
        outline: none;
        transition: border-color 0.15s;
    }

    .fp-search::placeholder {
        color: #4b5563;
    }

    .fp-search:focus {
        border-color: #3b82f6;
    }

    .fp-search-clear {
        position: absolute;
        right: 1.125rem;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        padding: 0;
        background: none;
        border: none;
        color: #6b7280;
        cursor: pointer;
    }

    .fp-search-clear:hover {
        color: #e5e7eb;
    }

    .fp-search-clear svg {
        width: 0.75rem;
        height: 0.75rem;
    }

    .fp-list {
        flex: 1;
        overflow-y: auto;
        padding: 0.25rem 0;
    }

    .fp-dir + .fp-dir {
        margin-top: 0.125rem;
    }

    .fp-dir-header {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        width: 100%;
        padding: 0.375rem 0.75rem;
        background: transparent;
        border: none;
        color: #9ca3af;
        font-size: 0.75rem;
        cursor: pointer;
        text-align: left;
        transition: color 0.15s;
    }

    .fp-dir-header:hover {
        color: #e5e7eb;
    }

    .fp-chevron {
        width: 0.75rem;
        height: 0.75rem;
        flex-shrink: 0;
        transition: transform 0.15s;
    }

    .fp-chevron.collapsed {
        transform: rotate(-90deg);
    }

    .fp-folder {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
        color: #6b7280;
    }

    .fp-dir-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .fp-dir-count {
        font-size: 0.6875rem;
        color: #4b5563;
    }

    .fp-file {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.3125rem 0.75rem 0.3125rem 2rem;
        background: transparent;
        border: none;
        color: #d1d5db;
        font-size: 0.8125rem;
        cursor: pointer;
        text-align: left;
        border-left: 2px solid transparent;
        transition: all 0.1s;
    }

    .fp-file:hover {
        background: rgba(255,255,255,0.04);
    }

    .fp-file.selected {
        background: rgba(59,130,246,0.1);
        border-left-color: #3b82f6;
        color: #e5e7eb;
    }

    .fp-file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .fp-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .fp-dot--fresh { background: ${STATUS_META.fresh.color}; }
    .fp-dot--stale { background: ${STATUS_META.stale.color}; }
    .fp-dot--broken { background: ${STATUS_META.broken.color}; }

    .fp-status-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-top: 1px solid #1f1f1f;
    }

    .fp-stat {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.6875rem;
        font-variant-numeric: tabular-nums;
    }

    .fp-stat-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
    }

    .fp-stat--fresh { color: ${STATUS_META.fresh.color}; }
    .fp-stat--fresh .fp-stat-dot { background: ${STATUS_META.fresh.color}; }
    .fp-stat--stale { color: ${STATUS_META.stale.color}; }
    .fp-stat--stale .fp-stat-dot { background: ${STATUS_META.stale.color}; }
    .fp-stat--broken { color: ${STATUS_META.broken.color}; }
    .fp-stat--broken .fp-stat-dot { background: ${STATUS_META.broken.color}; }

    .fp-no-results {
        padding: 1.5rem 1rem;
        text-align: center;
        color: #6b7280;
        font-size: 0.8125rem;
    }

    .fp-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 2rem 1rem;
        text-align: center;
    }

    .fp-empty svg {
        width: 3rem;
        height: 3rem;
        color: #374151;
    }

    .fp-empty-title {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 500;
        color: #9ca3af;
    }

    .fp-empty-hint {
        margin: 0;
        font-size: 0.8125rem;
        color: #4b5563;
    }
`;
