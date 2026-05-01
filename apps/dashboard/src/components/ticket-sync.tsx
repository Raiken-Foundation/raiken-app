import { useState } from "react";
import { trpc } from "../utils/trpc";

interface TicketSyncProps {
    onGenerateTest?: (prompt: string) => void;
}

export function TicketSyncBar({ onGenerateTest }: TicketSyncProps) {
    const [expanded, setExpanded] = useState(false);

    const statusQuery = trpc.getTicketStatus.useQuery(
        {},
        { refetchInterval: 30000, retry: 1 },
    );

    const syncMutation = trpc.syncTicket.useMutation();

    const handleSync = () => {
        syncMutation.mutate({});
    };

    const branch = statusQuery.data?.branch;
    const ticketHint = statusQuery.data?.ticket;
    const impact = syncMutation.data?.impact;
    const ticket = syncMutation.data?.ticket;
    const isSyncing = syncMutation.isPending;

    return (
        <div className="ticket-sync-bar">
            <div className="ticket-sync-header">
                <div className="ticket-sync-left">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="ticket-icon"
                    >
                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                        <rect x="9" y="3" width="6" height="4" rx="1" />
                        <path d="M9 12h6M9 16h4" />
                    </svg>

                    {ticket ? (
                        <span className="ticket-info">
                            <a
                                href={ticket.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ticket-link"
                            >
                                #{ticket.id}
                            </a>
                            <span className="ticket-title">{ticket.title}</span>
                        </span>
                    ) : ticketHint ? (
                        <span className="ticket-info">
                            <span className="ticket-hint">
                                #{ticketHint.id} detected on{" "}
                                <code>{branch}</code>
                            </span>
                        </span>
                    ) : branch ? (
                        <span className="ticket-info">
                            <code className="branch-name">{branch}</code>
                            <span className="ticket-none">No ticket detected</span>
                        </span>
                    ) : (
                        <span className="ticket-none">Not in a git repository</span>
                    )}
                </div>

                <div className="ticket-sync-right">
                    {impact && (
                        <button
                            type="button"
                            className="impact-toggle"
                            onClick={() => setExpanded(!expanded)}
                        >
                            {impact.affectedTestFiles.length > 0 ? (
                                <span className="impact-badge warn">
                                    {new Set(impact.affectedTestFiles.map((t) => t.testFile)).size} test(s) affected
                                </span>
                            ) : impact.affectedSourceFiles.length > 0 ? (
                                <span className="impact-badge info">
                                    {impact.affectedSourceFiles.length} file(s) affected
                                </span>
                            ) : (
                                <span className="impact-badge ok">No impact</span>
                            )}
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className={`chevron ${expanded ? "expanded" : ""}`}
                            >
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                    )}

                    <button
                        type="button"
                        className="sync-btn"
                        onClick={handleSync}
                        disabled={isSyncing}
                        title="Sync with ticket system"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className={isSyncing ? "spinning" : ""}
                        >
                            <path d="M4 4v5h5M20 20v-5h-5" />
                            <path d="M20.49 9A9 9 0 005.64 5.64L4 4m16 16l-1.64-1.64A9 9 0 013.51 15" />
                        </svg>
                        {isSyncing ? "Syncing..." : "Sync"}
                    </button>
                </div>
            </div>

            {expanded && impact && (
                <ImpactPanel impact={impact} onGenerateTest={onGenerateTest} />
            )}

            {syncMutation.isError && (
                <div className="sync-error">
                    Sync failed: {syncMutation.error?.message || "Unknown error"}
                </div>
            )}

            <style>{ticketSyncStyles}</style>
        </div>
    );
}

interface ImpactEvidence {
    reason: string;
    provenance?: string;
    confidence: number;
    line?: number;
    snippet?: string;
    sourceSymbol?: string;
    targetSymbol?: string;
}

interface ImpactPanelProps {
    impact: {
        summary: string;
        affectedSourceFiles: string[];
        affectedTestFiles: Array<{
            testFile: string;
            reason: string;
            sourceFile: string;
            confidence?: number;
            evidence?: ImpactEvidence[];
        }>;
        affectedSymbols?: Array<{
            file: string;
            name: string;
            kind: string;
            startLine: number;
            endLine: number;
            confidence: number;
        }>;
        suggestions: Array<{
            action: string;
            testFile?: string;
            reason: string;
            suggestedPrompt?: string;
        }>;
        analyzedAt: string;
    };
    onGenerateTest?: (prompt: string) => void;
}

function ImpactPanel({ impact, onGenerateTest }: ImpactPanelProps) {
    const [openTest, setOpenTest] = useState<string | null>(null);

    // Group rows by test file; aggregate the highest confidence and merge evidence.
    const testGroups = new Map<
        string,
        {
            testFile: string;
            reasons: Set<string>;
            confidence: number;
            evidence: ImpactEvidence[];
            sources: Set<string>;
        }
    >();
    for (const row of impact.affectedTestFiles) {
        const existing = testGroups.get(row.testFile) ?? {
            testFile: row.testFile,
            reasons: new Set<string>(),
            confidence: 0,
            evidence: [],
            sources: new Set<string>(),
        };
        existing.reasons.add(row.reason);
        if (row.sourceFile) existing.sources.add(row.sourceFile);
        if (typeof row.confidence === "number") {
            existing.confidence = Math.max(existing.confidence, row.confidence);
        }
        if (row.evidence) existing.evidence.push(...row.evidence);
        testGroups.set(row.testFile, existing);
    }

    const uniqueTests = [...testGroups.values()].sort(
        (a, b) => b.confidence - a.confidence,
    );

    return (
        <div className="impact-panel">
            <p className="impact-summary">{impact.summary}</p>

            {uniqueTests.length > 0 && (
                <div className="impact-section">
                    <h4>Affected Tests</h4>
                    <ul className="impact-list">
                        {uniqueTests.map((group) => {
                            const isOpen = openTest === group.testFile;
                            const confPct = Math.round((group.confidence || 0) * 100);
                            return (
                                <li key={group.testFile} className="impact-item test column">
                                    <button
                                        type="button"
                                        className="test-row"
                                        onClick={() =>
                                            setOpenTest(isOpen ? null : group.testFile)
                                        }
                                    >
                                        <span className="dot warn" />
                                        <span className="item-path">{group.testFile}</span>
                                        <span className="item-reason">
                                            {[...group.reasons].join(", ")}
                                        </span>
                                        {confPct > 0 && (
                                            <span
                                                className={`confidence-pill ${confPct >= 80 ? "high" : confPct >= 50 ? "med" : "low"}`}
                                                title="Confidence this test is impacted"
                                            >
                                                {confPct}%
                                            </span>
                                        )}
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            className={`chevron sm ${isOpen ? "expanded" : ""}`}
                                        >
                                            <path d="M6 9l6 6 6-6" />
                                        </svg>
                                    </button>
                                    {isOpen && (
                                        <div className="evidence-block">
                                            {group.sources.size > 0 && (
                                                <div className="evidence-line">
                                                    <span className="evidence-label">Covers:</span>
                                                    <span className="evidence-value">
                                                        {[...group.sources].join(", ")}
                                                    </span>
                                                </div>
                                            )}
                                            {group.evidence.length === 0 ? (
                                                <div className="evidence-line muted">
                                                    No detailed evidence.
                                                </div>
                                            ) : (
                                                <ul className="evidence-list">
                                                    {group.evidence
                                                        .slice()
                                                        .sort((a, b) => b.confidence - a.confidence)
                                                        .slice(0, 8)
                                                        .map((e, i) => (
                                                            <li key={i} className="evidence-row">
                                                                <span
                                                                    className={`reason-tag ${e.reason}`}
                                                                >
                                                                    {e.reason}
                                                                </span>
                                                                {e.provenance && (
                                                                    <span className="prov-tag">
                                                                        {e.provenance}
                                                                    </span>
                                                                )}
                                                                {(e.sourceSymbol || e.targetSymbol) && (
                                                                    <span className="symbol-text">
                                                                        {e.sourceSymbol ?? "?"}
                                                                        {" → "}
                                                                        {e.targetSymbol ?? "?"}
                                                                    </span>
                                                                )}
                                                                {e.snippet && (
                                                                    <code className="snippet">
                                                                        {e.snippet}
                                                                    </code>
                                                                )}
                                                                <span className="evidence-conf">
                                                                    {Math.round(e.confidence * 100)}%
                                                                </span>
                                                            </li>
                                                        ))}
                                                </ul>
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {impact.affectedSymbols && impact.affectedSymbols.length > 0 && (
                <div className="impact-section">
                    <h4>
                        Likely Hot Symbols
                        <span className="count">{impact.affectedSymbols.length}</span>
                    </h4>
                    <ul className="impact-list">
                        {impact.affectedSymbols.slice(0, 8).map((s, i) => (
                            <li key={`${s.file}:${s.name}:${i}`} className="impact-item">
                                <span className="dot create" />
                                <span className="item-path">
                                    {s.name}
                                    <span className="kind-tag">{s.kind}</span>
                                </span>
                                <span className="item-reason">
                                    {s.file}:{s.startLine}
                                </span>
                                <span
                                    className={`confidence-pill ${s.confidence >= 0.8 ? "high" : s.confidence >= 0.5 ? "med" : "low"}`}
                                >
                                    {Math.round(s.confidence * 100)}%
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {impact.affectedSourceFiles.length > 0 && (
                <div className="impact-section">
                    <h4>
                        Affected Source Files
                        <span className="count">{impact.affectedSourceFiles.length}</span>
                    </h4>
                    <ul className="impact-list">
                        {impact.affectedSourceFiles.slice(0, 10).map((f) => (
                            <li key={f} className="impact-item">
                                <span className="dot info" />
                                <span className="item-path">{f}</span>
                            </li>
                        ))}
                        {impact.affectedSourceFiles.length > 10 && (
                            <li className="impact-item more">
                                +{impact.affectedSourceFiles.length - 10} more
                            </li>
                        )}
                    </ul>
                </div>
            )}

            {impact.suggestions.length > 0 && (
                <div className="impact-section">
                    <h4>Suggestions</h4>
                    <ul className="impact-list">
                        {impact.suggestions.map((s, i) => (
                            <li key={i} className="impact-item suggestion">
                                <span
                                    className={`dot ${s.action === "create_test" ? "create" : s.action === "update_test" ? "warn" : s.action === "review_test" ? "info" : "ok"}`}
                                />
                                <span className="item-reason">{s.reason}</span>
                                {s.suggestedPrompt && onGenerateTest && (
                                    <button
                                        type="button"
                                        className="use-prompt-btn"
                                        onClick={() => onGenerateTest(s.suggestedPrompt!)}
                                    >
                                        Generate
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="impact-footer">
                Analyzed {new Date(impact.analyzedAt).toLocaleTimeString()}
            </div>
        </div>
    );
}

const ticketSyncStyles = `
    .ticket-sync-bar {
        border-bottom: 1px solid var(--hair);
        background: var(--bg-bar);
        font-family: var(--mono);
        font-size: 12px;
    }

    .ticket-sync-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.3125rem 0.75rem;
        min-height: 32px;
    }

    .ticket-sync-left {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        min-width: 0;
    }

    .ticket-icon {
        width: 12px;
        height: 12px;
        color: var(--ink-faint);
        flex-shrink: 0;
    }

    .ticket-info {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        min-width: 0;
    }

    .ticket-link {
        color: var(--accent);
        text-decoration: none;
        flex-shrink: 0;
    }
    .ticket-link:hover { text-decoration: underline; }

    .ticket-title {
        color: var(--ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .ticket-hint { color: var(--ink-dim); }
    .ticket-none { color: var(--ink-faint); }

    .branch-name {
        font-size: 11px;
        padding: 1px 5px;
        background: var(--bg);
        border: 1px solid var(--hair-strong);
        color: var(--accent);
        font-family: var(--mono);
    }

    .ticket-sync-right {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        flex-shrink: 0;
    }

    .impact-toggle {
        display: flex;
        align-items: center;
        gap: 0.3125rem;
        padding: 2px 6px;
        background: transparent;
        border: 1px solid var(--hair-strong);
        color: var(--ink-dim);
        cursor: pointer;
        font-size: 11px;
        font-family: var(--mono);
        transition: color 0.12s, border-color 0.12s;
    }
    .impact-toggle:hover { border-color: var(--accent-dim); color: var(--ink); }

    .impact-badge { font-weight: 500; }
    .impact-badge.warn { color: var(--warn); }
    .impact-badge.info { color: var(--info); }
    .impact-badge.ok { color: var(--pass); }

    .chevron {
        width: 12px;
        height: 12px;
        transition: transform 0.15s;
        color: var(--ink-faint);
    }
    .chevron.expanded { transform: rotate(180deg); }

    .sync-btn {
        display: flex;
        align-items: center;
        gap: 0.3125rem;
        padding: 3px 8px;
        background: transparent;
        border: 1px solid var(--accent-dim);
        color: var(--accent);
        cursor: pointer;
        font-size: 11px;
        font-family: var(--mono);
        transition: background 0.12s, border-color 0.12s;
    }
    .sync-btn:hover { background: var(--accent-dim); border-color: var(--accent); }
    .sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sync-btn svg { width: 11px; height: 11px; }

    @keyframes ts-spin { to { transform: rotate(360deg); } }
    .sync-btn svg.spinning { animation: ts-spin 0.9s linear infinite; }

    .sync-error {
        padding: 0.3125rem 0.75rem;
        background: var(--fail-soft);
        color: var(--fail);
        font-size: 11px;
        border-top: 1px solid rgba(215, 92, 92, 0.3);
    }

    .impact-panel {
        padding: 0.625rem 0.75rem;
        border-top: 1px solid var(--hair);
        background: var(--bg);
        max-height: 300px;
        overflow-y: auto;
    }

    .impact-summary {
        color: var(--ink-dim);
        margin: 0 0 0.625rem;
        line-height: 1.5;
        font-size: 12px;
    }

    .impact-section { margin-bottom: 0.625rem; }

    .impact-section h4 {
        color: var(--ink-faint);
        font-size: 10.5px;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        margin: 0 0 0.3125rem;
        display: flex;
        align-items: center;
        gap: 0.4375rem;
    }
    .impact-section h4::before { content: "#"; color: var(--accent); font-weight: 400; }

    .impact-section .count { color: var(--ink-faint); font-weight: 400; }

    .impact-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }

    .impact-item {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        padding: 0.1875rem 0.25rem;
        font-size: 11.5px;
    }

    .impact-item.more {
        color: var(--ink-faint);
        padding-left: 1.125rem;
    }

    .dot {
        width: 6px;
        height: 6px;
        flex-shrink: 0;
    }
    .dot.warn { background: var(--warn); }
    .dot.info { background: var(--info); }
    .dot.ok { background: var(--pass); }
    .dot.create { background: var(--accent); }

    .item-path {
        color: var(--ink);
        font-family: var(--mono);
        font-size: 11px;
    }

    .item-reason { color: var(--ink-dim); }

    .impact-item.suggestion { flex-wrap: wrap; }

    .use-prompt-btn {
        margin-left: auto;
        padding: 1px 6px;
        background: transparent;
        border: 1px solid var(--accent-dim);
        color: var(--accent);
        font-size: 10.5px;
        font-family: var(--mono);
        cursor: pointer;
        transition: background 0.12s;
    }
    .use-prompt-btn:hover { background: var(--accent-dim); }

    .impact-footer {
        color: var(--ink-faint);
        font-size: 10.5px;
        margin-top: 0.4375rem;
        text-align: right;
        font-variant-numeric: tabular-nums;
    }

    .impact-item.column {
        flex-direction: column;
        align-items: stretch;
        padding: 0;
    }

    .test-row {
        display: flex;
        align-items: center;
        gap: 0.4375rem;
        padding: 0.25rem 0.3125rem;
        background: transparent;
        border: 0;
        cursor: pointer;
        text-align: left;
        color: inherit;
        font: inherit;
    }
    .test-row:hover { background: var(--bg-hover); }

    .chevron.sm {
        width: 10px;
        height: 10px;
        margin-left: auto;
        opacity: 0.7;
    }

    .confidence-pill {
        padding: 0 5px;
        font-size: 10px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
        border: 1px solid var(--hair-strong);
        background: var(--bg);
    }
    .confidence-pill.high { background: var(--pass-soft); color: var(--pass); border-color: rgba(111, 184, 111, 0.3); }
    .confidence-pill.med { background: var(--warn-soft); color: var(--warn); border-color: rgba(217, 164, 65, 0.3); }
    .confidence-pill.low { background: var(--bg); color: var(--ink-dim); }

    .evidence-block {
        margin: 0.1875rem 0 0.4375rem 1.25rem;
        padding: 0.4375rem 0.5rem;
        background: var(--bg-sunken);
        border: 1px solid var(--hair);
        display: flex;
        flex-direction: column;
        gap: 0.3125rem;
    }

    .evidence-line { font-size: 10.5px; color: var(--ink); }
    .evidence-line.muted { color: var(--ink-faint); }
    .evidence-label {
        color: var(--ink-faint);
        margin-right: 0.3125rem;
    }
    .evidence-value { font-family: var(--mono); color: var(--accent); }

    .evidence-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.1875rem;
    }

    .evidence-row {
        display: flex;
        align-items: center;
        gap: 0.3125rem;
        font-size: 10.5px;
        color: var(--ink-dim);
        flex-wrap: wrap;
    }

    .reason-tag {
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.04em;
        padding: 0 5px;
        font-weight: 500;
        background: var(--bg-bar);
        border: 1px solid var(--hair-strong);
        color: var(--ink-dim);
        font-family: var(--mono);
    }
    .reason-tag.source_map { background: var(--pass-soft); color: var(--pass); border-color: rgba(111, 184, 111, 0.3); }
    .reason-tag.runtime { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-dim); }
    .reason-tag.imports { background: var(--info-soft); color: var(--info); border-color: rgba(111, 163, 198, 0.3); }
    .reason-tag.calls { background: var(--warn-soft); color: var(--warn); border-color: rgba(217, 164, 65, 0.3); }
    .reason-tag.renders { background: var(--fail-soft); color: var(--fail); border-color: rgba(215, 92, 92, 0.3); }
    .reason-tag.name_match { background: var(--bg); color: var(--ink-dim); }

    .prov-tag {
        font-size: 10px;
        color: var(--ink-faint);
    }

    .symbol-text {
        font-family: var(--mono);
        color: var(--ink);
    }

    .snippet {
        font-family: var(--mono);
        font-size: 10px;
        color: var(--ink-dim);
        padding: 0 4px;
        background: var(--bg);
        border: 1px solid var(--hair-soft);
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .evidence-conf {
        margin-left: auto;
        font-size: 10px;
        color: var(--ink-faint);
        font-variant-numeric: tabular-nums;
    }

    .kind-tag {
        margin-left: 0.3125rem;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ink-faint);
    }
`;
