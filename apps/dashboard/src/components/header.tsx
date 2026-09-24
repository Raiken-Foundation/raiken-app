import { Logo } from "./logo";

interface HeaderProps {
    projectName: string;
    staleCount?: number;
    failedCount?: number;
}

export function Header({ projectName, staleCount = 0, failedCount = 0 }: HeaderProps) {
    return (
        <header className="header">
            <div className="header-left">
                <span className="header-brand">
                    <Logo size={14} />
                    <span className="header-brand-text">raiken</span>
                </span>
                <span className="header-sep" aria-hidden="true">
                    /
                </span>
                <span className="header-key">project</span>
                <span className="header-val">{projectName}</span>
            </div>

            <div className="header-center">
                {staleCount > 0 && (
                    <span className="header-stat header-stat--warn" title={`${staleCount} stale`}>
                        <span className="q-dot q-dot--warn" />
                        <span className="header-stat-val">{staleCount}</span>
                        <span className="header-stat-label">stale</span>
                    </span>
                )}
                {failedCount > 0 && (
                    <span className="header-stat header-stat--fail" title={`${failedCount} failed`}>
                        <span className="q-dot q-dot--fail" />
                        <span className="header-stat-val">{failedCount}</span>
                        <span className="header-stat-label">failed</span>
                    </span>
                )}
                {staleCount === 0 && failedCount === 0 && (
                    <span className="header-stat header-stat--ok">
                        <span className="q-dot q-dot--ok" />
                        <span className="header-stat-label">clean</span>
                    </span>
                )}
            </div>

            <style>{`
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 1rem;
                    height: 28px;
                    padding: 0 0.875rem;
                    background: var(--bg-bar);
                    border-bottom: 1px solid var(--hair);
                    font-family: var(--mono);
                    font-size: 11px;
                    color: var(--ink-dim);
                    flex-shrink: 0;
                }
                .header-left,
                .header-center {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    min-width: 0;
                }
                .header-center {
                    flex: 1;
                    justify-content: flex-end;
                    gap: 0.875rem;
                }
                .header-brand {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4375rem;
                    color: var(--accent);
                }
                .header-brand-text {
                    color: var(--accent);
                }
                .header-sep,
                .header-key {
                    color: var(--ink-faint);
                }
                .header-val {
                    color: var(--ink);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 240px;
                }
                .header-stat {
                    display: inline-flex;
                    align-items: baseline;
                    gap: 0.375rem;
                    font-variant-numeric: tabular-nums;
                }
                .header-stat-val {
                    color: var(--ink);
                    font-weight: 500;
                }
                .header-stat-label {
                    color: var(--ink-faint);
                    text-transform: lowercase;
                }
                .header-stat--warn .header-stat-val {
                    color: var(--warn);
                }
                .header-stat--fail .header-stat-val {
                    color: var(--fail);
                }
                .header-stat--ok .header-stat-label {
                    color: var(--pass);
                }
            `}</style>
        </header>
    );
}
