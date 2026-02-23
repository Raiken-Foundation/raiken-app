import { useEffect, useMemo, useState, useRef } from "react";
import { Header } from "../components/header";
import { trpc } from "../utils/trpc";

function parseOptionalPositiveInt(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatDate(value: string | null | undefined): string {
    if (!value) return "n/a";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
}

const POLL_RUNTIME_IDLE_MS = 15_000;
const POLL_RUNTIME_ACTIVE_MS = 3_000;
const POLL_DATA_IDLE_MS = 20_000;
const POLL_DATA_ACTIVE_MS = 4_000;
const PAGES_PER_PAGE = 20;
const DEFAULT_EXCLUDE = ["/logout", "/delete", "/admin", "/billing", "/danger"];

type DiscoveryTab = "overview" | "results";
type ResultsSubTab = "pages" | "verified" | "broken";

interface DiscoveryViewProps {
    onGenerateTest?: (pageUrl: string) => void;
}

export function DiscoveryView({ onGenerateTest }: DiscoveryViewProps) {
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    useEffect(() => {
        if (toastMessage) {
            const timer = setTimeout(() => setToastMessage(null), 2500);
            return () => clearTimeout(timer);
        }
    }, [toastMessage]);

    const handleGenerateTest = (pageUrl: string) => {
        setToastMessage(`Sending to AI Agent: ${pageUrl}`);
        setTimeout(() => onGenerateTest?.(pageUrl), 600);
    };
    const utils = trpc.useUtils();
    const [runtimePollMs, setRuntimePollMs] = useState(POLL_RUNTIME_IDLE_MS);
    const [activeTab, setActiveTab] = useState<DiscoveryTab>("overview");
    const [resultsSubTab, setResultsSubTab] = useState<ResultsSubTab>("pages");
    const [selectedPageUrl, setSelectedPageUrl] = useState<string | null>(null);
    const [pageOffset, setPageOffset] = useState(0);
    const [dismissedCompletion, setDismissedCompletion] = useState(false);
    const excludeInputRef = useRef<HTMLInputElement>(null);

    const [form, setForm] = useState({
        url: "",
        maxPages: "100",
        maxDepth: "5",
        timeout: "30000",
        skipAuth: false,
        excludePatterns: [...DEFAULT_EXCLUDE],
    });

    const runtimeQuery = trpc.getDiscoveryRuntime.useQuery(
        {},
        { refetchInterval: runtimePollMs, refetchOnWindowFocus: false }
    );

    const runtime = runtimeQuery.data;
    const dataPollMs = runtime?.phase === "running" ? POLL_DATA_ACTIVE_MS : POLL_DATA_IDLE_MS;

    useEffect(() => {
        setRuntimePollMs(runtime?.phase === "running" ? POLL_RUNTIME_ACTIVE_MS : POLL_RUNTIME_IDLE_MS);
    }, [runtime?.phase]);

    const statsQuery = trpc.getDiscoveryStats.useQuery({}, { refetchInterval: dataPollMs, refetchOnWindowFocus: false });
    const sessionQuery = trpc.getDiscoverySession.useQuery({}, { refetchInterval: dataPollMs, refetchOnWindowFocus: false });
    const pagesQuery = trpc.getDiscoveredPages.useQuery(
        { limit: PAGES_PER_PAGE, offset: pageOffset },
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false }
    );
    const pageSnapshotQuery = trpc.getDiscoveredPageSnapshot.useQuery(
        { url: selectedPageUrl ?? "" },
        { enabled: Boolean(selectedPageUrl), refetchOnWindowFocus: false }
    );
    const blockersQuery = trpc.getAuthBlockers.useQuery({}, { refetchInterval: dataPollMs, refetchOnWindowFocus: false });
    const timelineQuery = trpc.getDiscoveryTimeline.useQuery({ limit: 50 }, { refetchInterval: dataPollMs, refetchOnWindowFocus: false });
    const linksQuery = trpc.getVerifiedLinks.useQuery({}, { refetchInterval: dataPollMs, refetchOnWindowFocus: false });
    const authAssistQuery = trpc.authAssist.useQuery({}, { enabled: false, refetchOnWindowFocus: false });

    useEffect(() => {
        if (runtime?.requiresAuth) authAssistQuery.refetch();
    }, [runtime?.requiresAuth]);

    const refreshAll = async () => {
        await Promise.all([
            utils.getDiscoveryRuntime.invalidate(),
            utils.getDiscoveryStats.invalidate(),
            utils.getDiscoverySession.invalidate(),
            utils.getDiscoveredPages.invalidate(),
            utils.getDiscoveredPageSnapshot.invalidate(),
            utils.getAuthBlockers.invalidate(),
            utils.getDiscoveryTimeline.invalidate(),
            utils.getVerifiedLinks.invalidate(),
        ]);
    };

    const startMutation = trpc.startDiscovery.useMutation({
        onSuccess: () => { setDismissedCompletion(false); refreshAll(); },
    });
    const continueMutation = trpc.continueDiscovery.useMutation({ onSuccess: refreshAll });
    const clearMutation = trpc.clearDiscoveryData.useMutation({ onSuccess: refreshAll });

    const isActionPending = startMutation.isPending || continueMutation.isPending || clearMutation.isPending;
    const isRunning = runtime?.phase === "running";
    const canContinue = (runtime?.phase === "paused" || sessionQuery.data?.status === "paused") && !isActionPending;
    const canStart = Boolean(form.url.trim()) && !isRunning && !isActionPending;

    const actionError = useMemo(() => {
        if (startMutation.error) return startMutation.error.message;
        if (continueMutation.error) return continueMutation.error.message;
        if (clearMutation.error) return clearMutation.error.message;
        if (runtime?.phase === "error") return runtime.lastError ?? "Discovery failed";
        return null;
    }, [startMutation.error, continueMutation.error, clearMutation.error, runtime?.phase, runtime?.lastError]);

    const handleStart = () => {
        if (!canStart) return;
        setDismissedCompletion(false);
        startMutation.mutate({
            url: form.url.trim(),
            maxPages: parseOptionalPositiveInt(form.maxPages),
            maxDepth: parseOptionalPositiveInt(form.maxDepth),
            timeout: parseOptionalPositiveInt(form.timeout),
            skipAuth: form.skipAuth,
            excludePatterns: form.excludePatterns.length > 0 ? form.excludePatterns : undefined,
        });
    };

    const handleContinue = () => {
        if (!canContinue) return;
        continueMutation.mutate({ skipAuth: form.skipAuth });
    };

    const handleClear = () => {
        if (isActionPending) return;
        setSelectedPageUrl(null);
        setPageOffset(0);
        clearMutation.mutate({});
    };

    const addExcludePattern = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || form.excludePatterns.includes(trimmed)) return;
        setForm(prev => ({ ...prev, excludePatterns: [...prev.excludePatterns, trimmed] }));
    };

    const removeExcludePattern = (pattern: string) => {
        setForm(prev => ({ ...prev, excludePatterns: prev.excludePatterns.filter(p => p !== pattern) }));
    };

    const handleExcludeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const input = e.currentTarget;
            addExcludePattern(input.value);
            input.value = "";
        }
    };

    const stats = statsQuery.data;
    const latestSession = sessionQuery.data;
    const pages = pagesQuery.data?.pages ?? [];
    const pagesTotal = pagesQuery.data?.total ?? 0;
    const pagesHasMore = pagesQuery.data?.hasMore ?? false;
    const blockers = blockersQuery.data?.blockers ?? [];
    const timeline = timelineQuery.data?.events ?? [];
    const selectedSnapshot = pageSnapshotQuery.data;
    const verifiedLinks = linksQuery.data?.verifiedLinks ?? [];
    const brokenLinks = linksQuery.data?.brokenLinks ?? [];

    const progressPct = useMemo(() => {
        if (!isRunning || !runtime?.maxPages) return null;
        const discovered = runtime.pagesDiscovered ?? 0;
        return Math.min(Math.round((discovered / runtime.maxPages) * 100), 100);
    }, [isRunning, runtime?.maxPages, runtime?.pagesDiscovered]);

    const totalResults = pagesTotal + verifiedLinks.length + brokenLinks.length;
    const showCompletion = runtime?.phase === "completed" && runtime.completionReason && !dismissedCompletion;

    return (
        <div className="discovery-view">
            <Header
                projectName="Discovery"
                staleCount={0}
                failedCount={runtime?.phase === "error" ? 1 : 0}
                userName="Developer"
                onMonitorSync={refreshAll}
            />

            <div className="view-body">
                <div className="view-shell">

                <nav className="dv-tabs">
                    <button type="button" className={`dv-tab ${activeTab === "overview" ? "active" : ""}`} onClick={() => setActiveTab("overview")}>
                        Overview
                    </button>
                    <button type="button" className={`dv-tab ${activeTab === "results" ? "active" : ""}`} onClick={() => setActiveTab("results")}>
                        Results
                        {totalResults > 0 && <span className="dv-tab-badge">{totalResults}</span>}
                    </button>
                </nav>

                {/* ═══════════ OVERVIEW ═══════════ */}
                {activeTab === "overview" && (
                    <div className="tab-content">

                        {/* ── Run ── */}
                        <section className="card">
                            <h2 className="card-title">Run Discovery</h2>

                            <label className="field">
                                <span className="field-label">Start URL</span>
                                <div className="url-row">
                                    <input
                                        value={form.url}
                                        onChange={(e) => setForm(prev => ({ ...prev, url: e.target.value }))}
                                        placeholder="http://localhost:3000"
                                    />
                                    {form.url && (
                                        <a className="url-open" href={form.url} target="_blank" rel="noreferrer" title="Open in browser">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                                <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                            </svg>
                                        </a>
                                    )}
                                </div>
                            </label>

                            <div className="field-row-3">
                                <label className="field">
                                    <span className="field-label">Max Pages</span>
                                    <input value={form.maxPages} onChange={(e) => setForm(prev => ({ ...prev, maxPages: e.target.value }))} />
                                </label>
                                <label className="field">
                                    <span className="field-label">Max Depth</span>
                                    <input value={form.maxDepth} onChange={(e) => setForm(prev => ({ ...prev, maxDepth: e.target.value }))} />
                                </label>
                                <label className="field">
                                    <span className="field-label">Timeout (ms)</span>
                                    <input value={form.timeout} onChange={(e) => setForm(prev => ({ ...prev, timeout: e.target.value }))} />
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
                                        onChange={(e) => setForm(prev => ({ ...prev, skipAuth: e.target.checked }))}
                                        className="sr-only"
                                    />
                                    <span className="toggle-label">Skip auth pause</span>
                                </label>
                            </div>

                            <div className="exclude-section">
                                <span className="field-label">Exclude patterns</span>
                                <div className="tags-wrap">
                                    {form.excludePatterns.map(p => (
                                        <span key={p} className="tag">
                                            {p}
                                            <button type="button" className="tag-x" onClick={() => removeExcludePattern(p)} aria-label={`Remove ${p}`}>&times;</button>
                                        </span>
                                    ))}
                                    <input
                                        ref={excludeInputRef}
                                        className="tag-input"
                                        placeholder="Add pattern…"
                                        onKeyDown={handleExcludeKeyDown}
                                    />
                                </div>
                            </div>

                            <div className="action-bar">
                                <button type="button" className="btn primary" onClick={handleStart} disabled={!canStart}>
                                    {startMutation.isPending ? "Starting…" : isRunning ? "Running…" : "Start Discovery"}
                                </button>
                                {canContinue && (
                                    <button type="button" className="btn" onClick={handleContinue} disabled={continueMutation.isPending}>
                                        {continueMutation.isPending ? "Continuing…" : "Continue"}
                                    </button>
                                )}
                                {runtime?.requiresAuth && (
                                    <button type="button" className="btn" onClick={() => authAssistQuery.refetch()} disabled={authAssistQuery.isFetching}>
                                        {authAssistQuery.isFetching ? "Loading…" : "Auth Assist"}
                                    </button>
                                )}
                                <button type="button" className="btn danger" onClick={handleClear} disabled={isActionPending}>
                                    {clearMutation.isPending ? "Clearing…" : "Clear Data"}
                                </button>
                            </div>

                            {actionError && (
                                <div className="error-banner"><strong>Error:</strong> {actionError}</div>
                            )}
                        </section>

                        {/* ── Banners ── */}
                        {isRunning && progressPct !== null && (
                            <div className="progress-bar-wrap">
                                <div className="progress-bar" style={{ width: `${progressPct}%` }} />
                                <span className="progress-label">{runtime?.pagesDiscovered ?? 0} / {runtime?.maxPages} pages ({progressPct}%)</span>
                            </div>
                        )}
                        {showCompletion && (
                            <div className="banner banner-success">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>
                                <span>Discovery complete &mdash; {runtime!.completionReason}</span>
                                <button type="button" className="banner-close" onClick={() => setDismissedCompletion(true)} aria-label="Dismiss">&times;</button>
                            </div>
                        )}
                        {runtime?.phase === "paused" && (
                            <div className="banner banner-warn">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                <span>Discovery paused &mdash; {runtime.requiresAuth ? "authentication required" : "waiting to continue"}</span>
                            </div>
                        )}
                        {runtime?.requiresAuth && (
                            <div className="banner banner-auth">
                                <div><strong>Authentication required.</strong> {authAssistQuery.data?.message ?? "Complete login and continue discovery."}</div>
                                <code>{authAssistQuery.data?.command ?? "raiken auth --url <login-url>"}</code>
                            </div>
                        )}

                        {/* ── Status ── */}
                        <section className="card">
                            <h2 className="card-title">Status</h2>
                            <div className="stat-grid">
                                <div className="stat">
                                    <span className="stat-label">Phase</span>
                                    <span className={`stat-value phase-${runtime?.phase ?? "idle"}`}>{runtime?.phase ?? "idle"}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Pages</span>
                                    <span className="stat-value">{stats?.pagesCount ?? runtime?.pagesDiscovered ?? 0}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Links</span>
                                    <span className="stat-value">{stats?.linksCount ?? runtime?.linksFound ?? 0}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Verified</span>
                                    <span className="stat-value clr-ok">{stats?.verifiedLinksCount ?? 0}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Broken</span>
                                    <span className="stat-value clr-err">{stats?.brokenLinksCount ?? 0}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Blockers</span>
                                    <span className={`stat-value ${(stats?.unresolvedBlockersCount ?? 0) > 0 ? "clr-warn" : ""}`}>
                                        {stats?.unresolvedBlockersCount ?? runtime?.authBlockersFound ?? 0}
                                    </span>
                                </div>
                            </div>

                            {latestSession && (
                                <div className="session-strip">
                                    <span className="session-kv"><span className="session-k">Session</span>{latestSession.status}</span>
                                    {latestSession.completedAt && (
                                        <span className="session-kv"><span className="session-k">Completed</span>{formatDate(latestSession.completedAt)}</span>
                                    )}
                                    {latestSession.blockedAtUrl && (
                                        <span className="session-kv"><span className="session-k">Blocked at</span><span className="session-url">{latestSession.blockedAtUrl}</span></span>
                                    )}
                                </div>
                            )}
                        </section>

                        {/* ── Activity ── */}
                        {(timeline.length > 0 || blockers.length > 0) && (
                            <section className="card">
                                <h2 className="card-title">Activity</h2>

                                {timeline.length > 0 && (
                                    <div className="timeline">
                                        {timeline.map((event) => (
                                            <div key={event.id} className="tl-event">
                                                <div className="tl-top">
                                                    <span className="tl-type">{event.type}</span>
                                                    <time className="tl-time">{formatDate(event.timestamp)}</time>
                                                </div>
                                                <p className="tl-msg">{event.message}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {blockers.length > 0 && (
                                    <>
                                        {timeline.length > 0 && <div className="card-divider" />}
                                        <div className="blocker-header">
                                            <span>Unresolved Blockers</span>
                                            <span className="blocker-count">{blockers.length}</span>
                                        </div>
                                        <div className="table-wrap">
                                            <table>
                                                <thead><tr><th>URL</th><th>Type</th><th>Discovered</th></tr></thead>
                                                <tbody>
                                                    {blockers.map((b) => (
                                                        <tr key={b.id ?? `${b.url}-${b.blockerType}`}>
                                                            <td className="url-cell">{b.url}</td>
                                                            <td>{b.blockerType}</td>
                                                            <td>{formatDate(b.discoveredAt)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </>
                                )}
                            </section>
                        )}
                    </div>
                )}

                {/* ═══════════ RESULTS ═══════════ */}
                {activeTab === "results" && (
                    <div className="tab-content">
                        <div className="results-sub-tabs">
                            <button type="button" className={`results-sub-tab ${resultsSubTab === "pages" ? "active" : ""}`} onClick={() => setResultsSubTab("pages")}>
                                Pages{pagesTotal > 0 && <span className="sub-badge">{pagesTotal}</span>}
                            </button>
                            <button type="button" className={`results-sub-tab ${resultsSubTab === "verified" ? "active" : ""}`} onClick={() => setResultsSubTab("verified")}>
                                Verified{(linksQuery.data?.verifiedCount ?? 0) > 0 && <span className="sub-badge good">{linksQuery.data?.verifiedCount}</span>}
                            </button>
                            <button type="button" className={`results-sub-tab ${resultsSubTab === "broken" ? "active" : ""}`} onClick={() => setResultsSubTab("broken")}>
                                Broken{(linksQuery.data?.brokenCount ?? 0) > 0 && <span className="sub-badge bad">{linksQuery.data?.brokenCount}</span>}
                            </button>
                        </div>

                        {resultsSubTab === "pages" && (
                            <section className="dv-section">
                                <div className="table-wrap"><table>
                                    <thead><tr><th>URL</th><th>Depth</th><th>Title</th><th>Actions</th></tr></thead>
                                    <tbody>
                                        {pages.length === 0 ? (
                                            <tr><td colSpan={4} className="empty-cell">No pages discovered yet.</td></tr>
                                        ) : pages.map((page) => (
                                            <tr key={`${page.url}-${page.depth}`}>
                                                <td className="url-cell" title={page.url}>{page.url}</td>
                                                <td>{page.depth}</td>
                                                <td>{page.title || "Untitled"}</td>
                                                <td><div className="page-actions">
                                                    <button type="button" className="table-action" onClick={() => setSelectedPageUrl(page.url)}>Snapshot</button>
                                                    <a className="table-action table-link" href={page.url} target="_blank" rel="noreferrer">Open</a>
                                                    {onGenerateTest && <button type="button" className="table-action generate" onClick={() => handleGenerateTest(page.url)}>Generate Test</button>}
                                                </div></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table></div>
                                {pagesTotal > PAGES_PER_PAGE && (
                                    <div className="pagination">
                                        <button type="button" className="btn sm" disabled={pageOffset === 0} onClick={() => setPageOffset(Math.max(0, pageOffset - PAGES_PER_PAGE))}>Previous</button>
                                        <span className="page-info">{pageOffset + 1}&ndash;{Math.min(pageOffset + PAGES_PER_PAGE, pagesTotal)} of {pagesTotal}</span>
                                        <button type="button" className="btn sm" disabled={!pagesHasMore} onClick={() => setPageOffset(pageOffset + PAGES_PER_PAGE)}>Next</button>
                                    </div>
                                )}
                                {selectedPageUrl && (
                                    <div className="snapshot-drawer">
                                        <div className="snapshot-bar">
                                            <span className="snapshot-title">DOM Snapshot</span>
                                            <button type="button" className="snapshot-close" onClick={() => setSelectedPageUrl(null)}>&times;</button>
                                        </div>
                                        {pageSnapshotQuery.isLoading ? (
                                            <p className="empty">Loading snapshot…</p>
                                        ) : !selectedSnapshot?.snapshotJson ? (
                                            <p className="empty">No snapshot available for this page.</p>
                                        ) : (
                                            <>
                                                <div className="snapshot-meta">
                                                    <span>{selectedSnapshot.url}</span>
                                                    <span>Depth {selectedSnapshot.depth}</span>
                                                    {selectedSnapshot.title && <span>{selectedSnapshot.title}</span>}
                                                </div>
                                                <pre className="snapshot-pre">{selectedSnapshot.snapshotJson}</pre>
                                            </>
                                        )}
                                    </div>
                                )}
                            </section>
                        )}

                        {resultsSubTab === "verified" && (
                            <div className="links-list">
                                {verifiedLinks.length === 0 ? <p className="empty">No verified paths yet.</p> : verifiedLinks.map((link, i) => (
                                    <div key={`v-${i}`} className="link-row">
                                        <div className="link-path">
                                            <span className="link-from" title={link.fromUrl}>{shortenUrl(link.fromUrl)}</span>
                                            <svg className="link-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14m-4-4l4 4-4 4" /></svg>
                                            <span className="link-to" title={link.toUrl}>{shortenUrl(link.toUrl)}</span>
                                        </div>
                                        <div className="link-meta">
                                            <code className="link-selector">{link.selector}</code>
                                            {link.linkText && <span className="link-text">{link.linkText}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {resultsSubTab === "broken" && (
                            <div className="links-list">
                                {brokenLinks.length === 0 ? <p className="empty">No broken links detected.</p> : brokenLinks.map((link, i) => (
                                    <div key={`b-${i}`} className="link-row broken">
                                        <div className="link-path">
                                            <span className="link-from" title={link.fromUrl}>{shortenUrl(link.fromUrl)}</span>
                                            <svg className="link-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14m-4-4l4 4-4 4" /></svg>
                                            <span className="link-to broken-url" title={link.toUrl}>{shortenUrl(link.toUrl)}</span>
                                        </div>
                                        {link.errorMessage && <span className="link-error">{link.errorMessage}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                </div>
            </div>

            {toastMessage && (
                <div className="dv-toast">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span>{toastMessage}</span>
                </div>
            )}

            <style>{STYLES}</style>
        </div>
    );
}

function shortenUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname === "/" ? u.host : u.pathname;
    } catch {
        return url.length > 50 ? `${url.slice(0, 47)}…` : url;
    }
}

export default DiscoveryView;

const STYLES = `
    .discovery-view {
        display: flex; flex-direction: column; flex: 1;
        min-height: 0; background: #0a0a0a; color: #e5e7eb; overflow: hidden;
    }
    .view-body { display: flex; min-height: 0; flex: 1; overflow: hidden; }
    .view-shell { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }

    /* ── Tabs ── */
    .dv-tabs {
        display: flex; border-bottom: 1px solid #1f1f1f;
        padding: 0 1.25rem; flex-shrink: 0; background: #0a0a0a;
    }
    .dv-tab {
        all: unset; padding: 0.625rem 1rem; font-size: 0.8125rem; color: #6b7280;
        cursor: pointer; border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
        display: flex; align-items: center; gap: 0.4rem;
    }
    .dv-tab:hover { color: #d1d5db; }
    .dv-tab.active { color: #e5e7eb; border-bottom-color: #3b82f6; }
    .dv-tab-badge {
        font-size: 0.6875rem; background: #1f1f1f; color: #9ca3af;
        padding: 0.05rem 0.4rem; border-radius: 9999px; min-width: 1.1rem; text-align: center;
    }
    .dv-tab.active .dv-tab-badge { background: rgba(59,130,246,.15); color: #93c5fd; }

    .tab-content {
        display: flex; flex-direction: column; gap: 0.875rem;
        padding: 1.25rem; flex: 1; overflow-y: auto; min-height: 0;
    }

    /* ── Card ── */
    .card {
        border: 1px solid #1a1a1a; background: #0e0e0e;
        display: flex; flex-direction: column; gap: 0.75rem;
        padding: 1rem 1.125rem;
    }
    .card-title {
        margin: 0 0 0.125rem; font-size: 0.75rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280;
        padding-bottom: 0.5rem; border-bottom: 1px solid #1a1a1a;
    }
    .card-divider { border-top: 1px solid #1a1a1a; margin: 0.25rem 0; }

    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

    /* ── Fields ── */
    .field { display: flex; flex-direction: column; gap: 0.3rem; }
    .field-label { font-size: 0.6875rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }

    .discovery-view input[type="text"],
    .discovery-view input:not([type]),
    .discovery-view textarea {
        background: #111; border: 1px solid #222; border-radius: 6px;
        color: #e5e7eb; padding: 0.45rem 0.6rem; font-size: 0.8125rem; font-family: inherit;
    }
    .discovery-view input:focus,
    .discovery-view textarea:focus { border-color: #3b82f6; outline: none; }

    .url-row { display: flex; gap: 0.375rem; }
    .url-row input { flex: 1; }
    .url-open {
        display: flex; align-items: center; justify-content: center;
        width: 2.125rem; flex-shrink: 0; background: #111; border: 1px solid #222;
        border-radius: 6px; color: #6b7280; text-decoration: none; transition: all 0.15s;
    }
    .url-open:hover { background: #1a1a1a; color: #e5e7eb; }
    .url-open svg { width: 0.875rem; height: 0.875rem; }

    .field-row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.625rem; }

    /* ── Toggle ── */
    .options-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .toggle { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
    .toggle-track {
        width: 28px; height: 16px; border-radius: 999px; background: #2a2a2a;
        position: relative; transition: background 0.2s; flex-shrink: 0;
    }
    .toggle-track.on { background: #3b82f6; }
    .toggle-thumb {
        position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
        border-radius: 50%; background: #e5e7eb; transition: transform 0.2s;
    }
    .toggle-track.on .toggle-thumb { transform: translateX(12px); }
    .toggle-label { font-size: 0.75rem; color: #9ca3af; user-select: none; }

    /* ── Exclude tags ── */
    .exclude-section { display: flex; flex-direction: column; gap: 0.375rem; }
    .tags-wrap {
        display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center;
        padding: 0.375rem 0.5rem; background: #111; border: 1px solid #222; border-radius: 6px;
        min-height: 2rem;
    }
    .tag {
        display: inline-flex; align-items: center; gap: 0.25rem;
        padding: 0.15rem 0.5rem; background: #1a1a2e; border: 1px solid #2a2a4a;
        border-radius: 4px; font-size: 0.6875rem; color: #a5b4fc;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .tag-x {
        all: unset; cursor: pointer; font-size: 0.875rem; line-height: 1;
        color: #6b7280; padding: 0 0.1rem; margin-left: 0.125rem;
    }
    .tag-x:hover { color: #f87171; }
    .tag-input {
        all: unset; flex: 1; min-width: 80px; font-size: 0.75rem; color: #e5e7eb;
        padding: 0.1rem 0;
    }
    .tag-input::placeholder { color: #4b5563; }

    /* ── Action bar ── */
    .action-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; padding-top: 0.25rem; }

    .btn {
        padding: 0.45rem 0.75rem; border: 1px solid #2a2a2a; background: #1f2937;
        color: #f9fafb; border-radius: 6px; font-size: 0.8125rem; cursor: pointer;
        transition: background 0.15s;
    }
    .btn:hover:not(:disabled) { background: #374151; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn.primary { background: #2563eb; border-color: #1d4ed8; color: #fff; }
    .btn.primary:hover:not(:disabled) { background: #1d4ed8; }
    .btn.danger { background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.35); color: #fca5a5; }
    .btn.danger:hover:not(:disabled) { background: rgba(239,68,68,.2); }
    .btn.sm { padding: 0.3rem 0.625rem; font-size: 0.75rem; }

    .error-banner {
        background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.35);
        color: #fecaca; border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.8125rem;
    }

    /* ── Progress ── */
    .progress-bar-wrap {
        position: relative; height: 1.375rem; background: #1f1f1f;
        border-radius: 6px; overflow: hidden;
    }
    .progress-bar {
        position: absolute; inset: 0;
        background: linear-gradient(90deg, #2563eb, #3b82f6);
        border-radius: 6px; transition: width 0.6s ease;
    }
    .progress-label {
        position: relative; z-index: 1; display: flex; align-items: center;
        justify-content: center; height: 100%; font-size: 0.6875rem;
        font-weight: 500; color: #e5e7eb;
    }

    /* ── Banners ── */
    .banner {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.8125rem;
    }
    .banner svg { width: 1rem; height: 1rem; flex-shrink: 0; }
    .banner span { flex: 1; }
    .banner-close {
        all: unset; cursor: pointer; font-size: 1.125rem; line-height: 1;
        color: inherit; opacity: 0.6; padding: 0 0.25rem;
    }
    .banner-close:hover { opacity: 1; }
    .banner-success { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.25); color: #4ade80; }
    .banner-warn { background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.25); color: #fbbf24; }
    .banner-auth {
        flex-direction: column; align-items: flex-start;
        background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.3);
        color: #fde68a; padding: 0.75rem;
    }
    .banner-auth code {
        display: inline-block; background: #111; padding: 0.375rem 0.5rem;
        border-radius: 4px; border: 1px solid #333; margin-top: 0.25rem;
        font-size: 0.75rem;
    }

    /* ── Stat Grid ── */
    .stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0; }
    .stat {
        display: flex; flex-direction: column; gap: 0.15rem;
        padding: 0.5rem 0.5rem; text-align: center;
    }
    .stat + .stat { border-left: 1px solid #1a1a1a; }
    .stat-label { font-size: 0.6rem; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 1rem; font-weight: 700; }
    .clr-ok { color: #4ade80; }
    .clr-err { color: #f87171; }
    .clr-warn { color: #fbbf24; }
    .phase-running { color: #4ade80; }
    .phase-paused { color: #fbbf24; }
    .phase-error { color: #f87171; }
    .phase-completed { color: #60a5fa; }
    .phase-idle { color: #555; }

    /* ── Session strip ── */
    .session-strip {
        display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem;
        padding-top: 0.625rem; border-top: 1px solid #1a1a1a;
        font-size: 0.75rem; color: #d1d5db;
    }
    .session-kv { display: flex; gap: 0.375rem; align-items: center; }
    .session-k { color: #555; }
    .session-url {
        max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ── Timeline ── */
    .timeline { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
    .tl-event { padding: 0.5rem 0; }
    .tl-event + .tl-event { border-top: 1px solid #141414; }
    .tl-top { display: flex; justify-content: space-between; align-items: center; }
    .tl-type { font-size: 0.75rem; font-weight: 600; color: #d1d5db; }
    .tl-time { font-size: 0.6875rem; color: #555; }
    .tl-msg { margin: 0.2rem 0 0; font-size: 0.75rem; color: #9ca3af; }

    .blocker-header {
        display: flex; align-items: center; gap: 0.5rem;
        font-size: 0.75rem; font-weight: 600; color: #9ca3af;
    }
    .blocker-count {
        font-size: 0.625rem; background: rgba(248,113,113,.12); color: #f87171;
        padding: 0.05rem 0.4rem; border-radius: 9999px;
    }

    /* ── Tables ── */
    .table-wrap { overflow: auto; max-height: 440px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th, td { border-bottom: 1px solid #1a1a1a; text-align: left; padding: 0.45rem 0.5rem; }
    th {
        color: #555; font-weight: 500; font-size: 0.6875rem;
        text-transform: uppercase; letter-spacing: 0.04em;
        position: sticky; top: 0; background: #0e0e0e;
    }
    .url-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty, .empty-cell { color: #555; font-style: italic; font-size: 0.8125rem; }
    .page-actions { display: flex; gap: 0.375rem; flex-wrap: wrap; }
    .table-action {
        all: unset; padding: 0.2rem 0.45rem; border: 1px solid #222;
        border-radius: 4px; background: #111; color: #d1d5db;
        font-size: 0.6875rem; cursor: pointer; text-decoration: none;
        display: inline-flex; align-items: center;
    }
    .table-action:hover { background: #1a1a1a; }
    a.table-link {
        all: revert;
        padding: 0.2rem 0.45rem; border: 1px solid #222;
        border-radius: 4px; background: #111; color: #d1d5db;
        font-size: 0.6875rem; cursor: pointer; text-decoration: none;
        display: inline-flex; align-items: center; box-sizing: border-box;
    }
    a.table-link:hover { background: #1a1a1a; }
    .table-action.generate { background: rgba(59,130,246,.1); border-color: rgba(59,130,246,.25); color: #93c5fd; }
    .table-action.generate:hover { background: rgba(59,130,246,.18); }

    .pagination {
        display: flex; align-items: center; justify-content: center;
        gap: 0.75rem; padding-top: 0.625rem; border-top: 1px solid #1a1a1a;
    }
    .page-info { font-size: 0.75rem; color: #555; }

    /* ── Snapshot ── */
    .snapshot-drawer {
        display: flex; flex-direction: column; gap: 0.5rem;
        margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #1a1a1a;
    }
    .snapshot-bar { display: flex; align-items: center; justify-content: space-between; }
    .snapshot-title { font-size: 0.8125rem; font-weight: 600; color: #9ca3af; }
    .snapshot-close {
        all: unset; cursor: pointer; font-size: 1.25rem; line-height: 1;
        color: #555; padding: 0 0.25rem;
    }
    .snapshot-close:hover { color: #e5e7eb; }
    .snapshot-meta { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.75rem; color: #555; }
    .snapshot-pre {
        margin: 0; padding: 0.75rem; border-radius: 6px; border: 1px solid #1a1a1a;
        background: #090909; color: #d1d5db; font-size: 0.75rem; line-height: 1.45;
        overflow: auto; max-height: 340px; white-space: pre-wrap; word-break: break-word;
    }

    /* ── Results sub-tabs ── */
    .results-sub-tabs {
        display: flex; border-bottom: 1px solid #1f1f1f;
        margin: -1.25rem -1.25rem 0; padding: 0 1.25rem;
    }
    .results-sub-tab {
        all: unset; padding: 0.5rem 0.875rem; font-size: 0.8125rem; color: #6b7280;
        cursor: pointer; border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
        display: flex; align-items: center; gap: 0.35rem;
    }
    .results-sub-tab:hover { color: #d1d5db; }
    .results-sub-tab.active { color: #e5e7eb; border-bottom-color: #3b82f6; }
    .sub-badge {
        font-size: 0.625rem; background: #1f1f1f; color: #9ca3af;
        padding: 0.05rem 0.35rem; border-radius: 9999px; min-width: 0.875rem; text-align: center;
    }
    .sub-badge.good { background: rgba(74,222,128,.08); color: #4ade80; }
    .sub-badge.bad { background: rgba(248,113,113,.08); color: #f87171; }
    .results-sub-tab.active .sub-badge { background: rgba(59,130,246,.12); color: #93c5fd; }

    .dv-section { display: flex; flex-direction: column; gap: 0.75rem; }

    /* ── Links ── */
    .links-list { flex: 1; overflow-y: auto; min-height: 0; }
    .link-row { padding: 0.5rem 0.25rem; transition: background 0.1s; }
    .link-row:hover { background: rgba(255,255,255,.02); }
    .link-row + .link-row { border-top: 1px solid #141414; }
    .link-path { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; }
    .link-from, .link-to { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link-from { color: #6b7280; max-width: 40%; }
    .link-to { color: #d1d5db; flex: 1; min-width: 0; }
    .link-to.broken-url { color: #f87171; text-decoration: line-through; }
    .link-arrow { width: 0.875rem; height: 0.875rem; color: #333; flex-shrink: 0; }
    .link-meta { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.2rem; flex-wrap: wrap; }
    .link-selector { font-size: 0.6875rem; color: #6ee7b7; background: rgba(110,231,183,.06); padding: 0.1rem 0.35rem; border-radius: 3px; }
    .link-text { font-size: 0.6875rem; color: #555; font-style: italic; }
    .link-error { display: block; margin-top: 0.2rem; font-size: 0.6875rem; color: #f87171; }

    /* ── Toast ── */
    .dv-toast {
        position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.625rem 1rem; background: #1d4ed8; color: #fff;
        border-radius: 8px; font-size: 0.8125rem; font-weight: 500;
        box-shadow: 0 8px 24px rgba(0,0,0,.5);
        animation: dv-toast-in 0.3s ease-out;
        z-index: 1000; max-width: 90vw;
    }
    .dv-toast svg { width: 1rem; height: 1rem; flex-shrink: 0; }
    @keyframes dv-toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(12px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    /* ── Responsive ── */
    @media (max-width: 900px) {
        .field-row-3 { grid-template-columns: 1fr 1fr; }
        .stat-grid { grid-template-columns: repeat(3, 1fr); }
        .stat + .stat:nth-child(4) { border-left: none; }
        .stat:nth-child(n+4) { border-top: 1px solid #1a1a1a; }
    }
    @media (max-width: 600px) {
        .field-row-3 { grid-template-columns: 1fr; }
        .stat-grid { grid-template-columns: repeat(2, 1fr); }
    }
`;
