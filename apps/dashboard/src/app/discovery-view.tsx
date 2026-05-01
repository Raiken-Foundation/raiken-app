import { useEffect, useMemo, useRef, useState } from "react";
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
        { refetchInterval: runtimePollMs, refetchOnWindowFocus: false },
    );

    const runtime = runtimeQuery.data;
    const dataPollMs = runtime?.phase === "running" ? POLL_DATA_ACTIVE_MS : POLL_DATA_IDLE_MS;

    useEffect(() => {
        setRuntimePollMs(
            runtime?.phase === "running" ? POLL_RUNTIME_ACTIVE_MS : POLL_RUNTIME_IDLE_MS,
        );
    }, [runtime?.phase]);

    const statsQuery = trpc.getDiscoveryStats.useQuery(
        {},
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const sessionQuery = trpc.getDiscoverySession.useQuery(
        {},
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const pagesQuery = trpc.getDiscoveredPages.useQuery(
        { limit: PAGES_PER_PAGE, offset: pageOffset },
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const pageSnapshotQuery = trpc.getDiscoveredPageSnapshot.useQuery(
        { url: selectedPageUrl ?? "" },
        { enabled: Boolean(selectedPageUrl), refetchOnWindowFocus: false },
    );
    const blockersQuery = trpc.getAuthBlockers.useQuery(
        {},
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const timelineQuery = trpc.getDiscoveryTimeline.useQuery(
        { limit: 50 },
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const linksQuery = trpc.getVerifiedLinks.useQuery(
        {},
        { refetchInterval: dataPollMs, refetchOnWindowFocus: false },
    );
    const authAssistQuery = trpc.authAssist.useQuery(
        {},
        { enabled: false, refetchOnWindowFocus: false },
    );

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
        onSuccess: () => {
            setDismissedCompletion(false);
            refreshAll();
        },
    });
    const continueMutation = trpc.continueDiscovery.useMutation({ onSuccess: refreshAll });
    const clearMutation = trpc.clearDiscoveryData.useMutation({ onSuccess: refreshAll });
    const pauseMutation = trpc.pauseDiscovery.useMutation({ onSuccess: refreshAll });
    const handoffMutation = trpc.requestBrowserHandoff.useMutation({ onSuccess: refreshAll });

    // Per-row action tracking so we can disable just the button the user
    // clicked, instead of greying out the whole panel while a single
    // continue mutation is in flight.
    const [pendingBlockerId, setPendingBlockerId] = useState<number | null>(null);
    const [pendingHandoffId, setPendingHandoffId] = useState<number | null>(null);

    const isActionPending =
        startMutation.isPending ||
        continueMutation.isPending ||
        clearMutation.isPending ||
        pauseMutation.isPending;
    const isRunning = runtime?.phase === "running";
    const canContinue =
        (runtime?.phase === "paused" || sessionQuery.data?.status === "paused") && !isActionPending;
    const canStart = Boolean(form.url.trim()) && !isRunning && !isActionPending;

    const actionError = useMemo(() => {
        if (startMutation.error) return startMutation.error.message;
        if (continueMutation.error) return continueMutation.error.message;
        if (clearMutation.error) return clearMutation.error.message;
        if (runtime?.phase === "error") return runtime.lastError ?? "Discovery failed";
        return null;
    }, [
        startMutation.error,
        continueMutation.error,
        clearMutation.error,
        runtime?.phase,
        runtime?.lastError,
    ]);

    const queryError = useMemo(() => {
        if (runtimeQuery.isError) return `Runtime query failed: ${runtimeQuery.error?.message}`;
        if (statsQuery.isError) return `Stats query failed: ${statsQuery.error?.message}`;
        if (pagesQuery.isError) return `Pages query failed: ${pagesQuery.error?.message}`;
        return null;
    }, [
        runtimeQuery.isError,
        runtimeQuery.error,
        statsQuery.isError,
        statsQuery.error,
        pagesQuery.isError,
        pagesQuery.error,
    ]);

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

    type BlockerResolution = "clear" | "skip" | "ignore_category" | "provide_state";
    type BlockerCategory =
        | "auth_required"
        | "captcha"
        | "consent_wall"
        | "rate_limited"
        | "geo_blocked"
        | "interstitial"
        | "error_page"
        | "manual"
        | "unknown";

    const resolveBlocker = (
        blockerId: number,
        category: BlockerCategory,
        resolution: BlockerResolution,
    ) => {
        if (isActionPending) return;
        setPendingBlockerId(blockerId);
        continueMutation.mutate(
            { blockerId, category, resolution, skipAuth: form.skipAuth },
            { onSettled: () => setPendingBlockerId(null) },
        );
    };

    const openHandoff = (blockerId: number, category: BlockerCategory) => {
        setPendingHandoffId(blockerId);
        handoffMutation.mutate(
            { blockerId, category },
            {
                onSettled: () => setPendingHandoffId(null),
                onSuccess: (result) => {
                    // The handoff helper marked the blocker(s) resolved and
                    // wrote auth-state.json. Auto-resume so the user doesn't
                    // have to click Continue separately. We pass
                    // `provide_state` (rather than `clear`) so the crawler
                    // purges Crawlee's persistent queue and re-crawls from
                    // startUrl with the new state — without that, the
                    // post-login link graph is invisible (Crawlee marks the
                    // pre-login URLs as already handled).
                    if (!result?.success) return;
                    const storageStatePath =
                        "storageStatePath" in result && typeof result.storageStatePath === "string"
                            ? result.storageStatePath
                            : undefined;
                    if (category === "auth_required" || storageStatePath) {
                        continueMutation.mutate({
                            blockerId,
                            category,
                            resolution: "provide_state",
                            storageStatePath,
                            skipAuth: form.skipAuth,
                        });
                    }
                },
            },
        );
    };

    const handlePause = () => {
        if (!isRunning || isActionPending) return;
        pauseMutation.mutate({});
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
        setForm((prev) => ({ ...prev, excludePatterns: [...prev.excludePatterns, trimmed] }));
    };

    const removeExcludePattern = (pattern: string) => {
        setForm((prev) => ({
            ...prev,
            excludePatterns: prev.excludePatterns.filter((p) => p !== pattern),
        }));
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
    const showCompletion =
        runtime?.phase === "completed" && runtime.completionReason && !dismissedCompletion;

    return (
        <div className="discovery-view">
            <Header projectName="Discovery" failedCount={runtime?.phase === "error" ? 1 : 0} />

            <div className="view-body">
                <div className="view-shell">
                <nav className="dv-tabs">
                        <button
                            type="button"
                            className={`dv-tab ${activeTab === "overview" ? "active" : ""}`}
                            onClick={() => setActiveTab("overview")}
                        >
                        Overview
                    </button>
                        <button
                            type="button"
                            className={`dv-tab ${activeTab === "results" ? "active" : ""}`}
                            onClick={() => setActiveTab("results")}
                        >
                        Results
                            {totalResults > 0 && (
                                <span className="dv-tab-badge">{totalResults}</span>
                            )}
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
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    url: e.target.value,
                                                }))
                                            }
                                        placeholder="http://localhost:3000"
                                    />
                                    {form.url && (
                                            <a
                                                className="url-open"
                                                href={form.url}
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
                                        </a>
                                    )}
                                </div>
                            </label>

                            <div className="field-row-3">
                                <label className="field">
                                    <span className="field-label">Max Pages</span>
                                        <input
                                            value={form.maxPages}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    maxPages: e.target.value,
                                                }))
                                            }
                                        />
                                </label>
                                <label className="field">
                                    <span className="field-label">Max Depth</span>
                                        <input
                                            value={form.maxDepth}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    maxDepth: e.target.value,
                                                }))
                                            }
                                        />
                                </label>
                                <label className="field">
                                    <span className="field-label">Timeout (ms)</span>
                                        <input
                                            value={form.timeout}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    timeout: e.target.value,
                                                }))
                                            }
                                        />
                                </label>
                            </div>

                            <div className="options-row">
                                <label className="toggle">
                                        <span
                                            className={`toggle-track ${form.skipAuth ? "on" : ""}`}
                                        >
                                        <span className="toggle-thumb" />
                                    </span>
                                    <input
                                        type="checkbox"
                                        checked={form.skipAuth}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    skipAuth: e.target.checked,
                                                }))
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
                                                    onClick={() => removeExcludePattern(p)}
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
                                        onKeyDown={handleExcludeKeyDown}
                                    />
                                </div>
                            </div>

                            <div className="action-bar">
                                    <button
                                        type="button"
                                        className="btn primary"
                                        onClick={handleStart}
                                        disabled={!canStart}
                                    >
                                        {startMutation.isPending
                                            ? "Starting…"
                                            : isRunning
                                              ? "Running…"
                                              : "Start Discovery"}
                                </button>
                                    {isRunning && (
                                        <button
                                            type="button"
                                            className="btn"
                                            onClick={handlePause}
                                            disabled={pauseMutation.isPending}
                                            title="Pause the running crawl. You can inspect blockers, drive a browser, or resume from the dashboard."
                                        >
                                            {pauseMutation.isPending ? "Pausing…" : "Pause"}
                                        </button>
                                    )}
                                {canContinue && (
                                        <button
                                            type="button"
                                            className="btn"
                                            onClick={handleContinue}
                                            disabled={continueMutation.isPending}
                                        >
                                            {continueMutation.isPending
                                                ? "Continuing…"
                                                : "Continue"}
                                    </button>
                                )}
                                {runtime?.requiresAuth && (
                                        <button
                                            type="button"
                                            className="btn"
                                            onClick={() => authAssistQuery.refetch()}
                                            disabled={authAssistQuery.isFetching}
                                        >
                                            {authAssistQuery.isFetching
                                                ? "Loading…"
                                                : "Auth Assist"}
                                    </button>
                                )}
                                    <button
                                        type="button"
                                        className="btn danger"
                                        onClick={handleClear}
                                        disabled={isActionPending}
                                    >
                                    {clearMutation.isPending ? "Clearing…" : "Clear Data"}
                                </button>
                            </div>

                            {actionError && (
                                    <div className="error-banner">
                                        <strong>Error:</strong> {actionError}
                                    </div>
                            )}
                            {queryError && !actionError && (
                                    <div className="error-banner">
                                        <strong>Data Error:</strong> {queryError}
                                    </div>
                            )}
                        </section>

                        {/* ── Banners ── */}
                        {isRunning && progressPct !== null && (
                            <div className="progress-bar-wrap">
                                    <div
                                        className="progress-bar"
                                        style={{ width: `${progressPct}%` }}
                                    />
                                    <span className="progress-label">
                                        {runtime?.pagesDiscovered ?? 0} / {runtime?.maxPages} pages
                                        ({progressPct}%)
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
                                    <span>
                                        Discovery complete &mdash; {runtime!.completionReason}
                                    </span>
                                    <button
                                        type="button"
                                        className="banner-close"
                                        onClick={() => setDismissedCompletion(true)}
                                        aria-label="Dismiss"
                                    >
                                        &times;
                                    </button>
                            </div>
                        )}
                            {runtime?.phase === "paused" && blockers.length === 0 && (
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
                            {blockers.length > 0 && (
                                <BlockerPanel
                                    blockers={blockers as BlockerRow[]}
                                    onResolve={resolveBlocker}
                                    onHandoff={openHandoff}
                                    pendingBlockerId={pendingBlockerId}
                                    pendingHandoffId={pendingHandoffId}
                                    isPending={isActionPending || handoffMutation.isPending}
                                    authAssistMessage={
                                        runtime?.requiresAuth ? authAssistQuery.data?.message : null
                                    }
                                    authAssistCommand={
                                        runtime?.requiresAuth ? authAssistQuery.data?.command : null
                                    }
                                />
                        )}

                        {/* ── Status ── */}
                        <section className="card">
                            <h2 className="card-title">Status</h2>
                            <div className="stat-grid">
                                <div className="stat">
                                    <span className="stat-label">Phase</span>
                                        <span
                                            className={`stat-value phase-${runtime?.phase ?? "idle"}`}
                                        >
                                            {runtime?.phase ?? "idle"}
                                        </span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Pages</span>
                                        <span className="stat-value">
                                            {stats?.pagesCount ?? runtime?.pagesDiscovered ?? 0}
                                        </span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Links</span>
                                        <span className="stat-value">
                                            {stats?.linksCount ?? runtime?.linksFound ?? 0}
                                        </span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Verified</span>
                                        <span className="stat-value clr-ok">
                                            {stats?.verifiedLinksCount ?? 0}
                                        </span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Broken</span>
                                        <span className="stat-value clr-err">
                                            {stats?.brokenLinksCount ?? 0}
                                        </span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Blockers</span>
                                        <span
                                            className={`stat-value ${(stats?.unresolvedBlockersCount ?? 0) > 0 ? "clr-warn" : ""}`}
                                        >
                                            {stats?.unresolvedBlockersCount ??
                                                runtime?.authBlockersFound ??
                                                0}
                                    </span>
                                </div>
                            </div>

                            {latestSession && (
                                <div className="session-strip">
                                        <span className="session-kv">
                                            <span className="session-k">Session</span>
                                            {latestSession.status}
                                        </span>
                                    {latestSession.completedAt && (
                                            <span className="session-kv">
                                                <span className="session-k">Completed</span>
                                                {formatDate(latestSession.completedAt)}
                                            </span>
                                    )}
                                    {latestSession.blockedAtUrl && (
                                            <span className="session-kv">
                                                <span className="session-k">Blocked at</span>
                                                <span className="session-url">
                                                    {latestSession.blockedAtUrl}
                                                </span>
                                            </span>
                                    )}
                                </div>
                            )}
                        </section>

                        {/* ── Activity ── */}
                            {timeline.length > 0 && (
                            <section className="card">
                                <h2 className="card-title">Activity</h2>

                                {timeline.length > 0 && (
                                    <div className="timeline">
                                        {timeline.map((event) => (
                                            <div key={event.id} className="tl-event">
                                                <div className="tl-top">
                                                        <span className="tl-type">
                                                            {event.type}
                                                        </span>
                                                        <time className="tl-time">
                                                            {formatDate(event.timestamp)}
                                                        </time>
                                                </div>
                                                <p className="tl-msg">{event.message}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                    {/* Per-blocker resolution actions live in the
                                     BlockerPanel above so unresolved blockers
                                     don't get rendered twice. The Activity card
                                     keeps just the timeline. */}
                            </section>
                        )}
                    </div>
                )}

                {/* ═══════════ RESULTS ═══════════ */}
                {activeTab === "results" && (
                    <div className="tab-content">
                        <div className="results-sub-tabs">
                                <button
                                    type="button"
                                    className={`results-sub-tab ${resultsSubTab === "pages" ? "active" : ""}`}
                                    onClick={() => setResultsSubTab("pages")}
                                >
                                    Pages
                                    {pagesTotal > 0 && (
                                        <span className="sub-badge">{pagesTotal}</span>
                                    )}
                            </button>
                                <button
                                    type="button"
                                    className={`results-sub-tab ${resultsSubTab === "verified" ? "active" : ""}`}
                                    onClick={() => setResultsSubTab("verified")}
                                >
                                    Verified
                                    {(linksQuery.data?.verifiedCount ?? 0) > 0 && (
                                        <span className="sub-badge good">
                                            {linksQuery.data?.verifiedCount}
                                        </span>
                                    )}
                            </button>
                                <button
                                    type="button"
                                    className={`results-sub-tab ${resultsSubTab === "broken" ? "active" : ""}`}
                                    onClick={() => setResultsSubTab("broken")}
                                >
                                    Broken
                                    {(linksQuery.data?.brokenCount ?? 0) > 0 && (
                                        <span className="sub-badge bad">
                                            {linksQuery.data?.brokenCount}
                                        </span>
                                    )}
                            </button>
                        </div>

                        {resultsSubTab === "pages" && (
                            <section className="dv-section">
                                    <div className="table-wrap">
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>URL</th>
                                                    <th>Depth</th>
                                                    <th>Title</th>
                                                    <th>Actions</th>
                                                </tr>
                                            </thead>
                                    <tbody>
                                        {pages.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={4} className="empty-cell">
                                                            No pages discovered yet.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    pages.map((page) => (
                                            <tr key={`${page.url}-${page.depth}`}>
                                                            <td
                                                                className="url-cell"
                                                                title={page.url}
                                                            >
                                                                {page.url}
                                                            </td>
                                                <td>{page.depth}</td>
                                                <td>{page.title || "Untitled"}</td>
                                                            <td>
                                                                <div className="page-actions">
                                                                    <button
                                                                        type="button"
                                                                        className="table-action"
                                                                        onClick={() =>
                                                                            setSelectedPageUrl(
                                                                                page.url,
                                                                            )
                                                                        }
                                                                    >
                                                                        Snapshot
                                                                    </button>
                                                                    <a
                                                                        className="table-action table-link"
                                                                        href={page.url}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                    >
                                                                        Open
                                                                    </a>
                                                                    {onGenerateTest && (
                                                                        <button
                                                                            type="button"
                                                                            className="table-action generate"
                                                                            onClick={() =>
                                                                                handleGenerateTest(
                                                                                    page.url,
                                                                                )
                                                                            }
                                                                        >
                                                                            Generate Test
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </td>
                                            </tr>
                                                    ))
                                                )}
                                    </tbody>
                                        </table>
                                    </div>
                                {pagesTotal > PAGES_PER_PAGE && (
                                    <div className="pagination">
                                            <button
                                                type="button"
                                                className="btn sm"
                                                disabled={pageOffset === 0}
                                                onClick={() =>
                                                    setPageOffset(
                                                        Math.max(0, pageOffset - PAGES_PER_PAGE),
                                                    )
                                                }
                                            >
                                                Previous
                                            </button>
                                            <span className="page-info">
                                                {pageOffset + 1}&ndash;
                                                {Math.min(pageOffset + PAGES_PER_PAGE, pagesTotal)}{" "}
                                                of {pagesTotal}
                                            </span>
                                            <button
                                                type="button"
                                                className="btn sm"
                                                disabled={!pagesHasMore}
                                                onClick={() =>
                                                    setPageOffset(pageOffset + PAGES_PER_PAGE)
                                                }
                                            >
                                                Next
                                            </button>
                                    </div>
                                )}
                                {selectedPageUrl && (
                                    <div className="snapshot-drawer">
                                        <div className="snapshot-bar">
                                            <span className="snapshot-title">DOM Snapshot</span>
                                                <button
                                                    type="button"
                                                    className="snapshot-close"
                                                    onClick={() => setSelectedPageUrl(null)}
                                                >
                                                    &times;
                                                </button>
                                        </div>
                                        {pageSnapshotQuery.isLoading ? (
                                            <p className="empty">Loading snapshot…</p>
                                        ) : !selectedSnapshot?.snapshotJson ? (
                                                <p className="empty">
                                                    No snapshot available for this page.
                                                </p>
                                        ) : (
                                            <>
                                                <div className="snapshot-meta">
                                                    <span>{selectedSnapshot.url}</span>
                                                    <span>Depth {selectedSnapshot.depth}</span>
                                                        {selectedSnapshot.title && (
                                                            <span>{selectedSnapshot.title}</span>
                                                        )}
                                                </div>
                                                    <pre className="snapshot-pre">
                                                        {selectedSnapshot.snapshotJson}
                                                    </pre>
                                            </>
                                        )}
                                    </div>
                                )}
                            </section>
                        )}

                        {resultsSubTab === "verified" && (
                            <div className="links-list">
                                    {verifiedLinks.length === 0 ? (
                                        <p className="empty">No verified paths yet.</p>
                                    ) : (
                                        verifiedLinks.map((link, i) => (
                                    <div key={`v-${i}`} className="link-row">
                                        <div className="link-path">
                                                    <span
                                                        className="link-from"
                                                        title={link.fromUrl}
                                                    >
                                                        {shortenUrl(link.fromUrl)}
                                                    </span>
                                                    <svg
                                                        className="link-arrow"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                        aria-hidden="true"
                                                    >
                                                        <path d="M5 12h14m-4-4l4 4-4 4" />
                                                    </svg>
                                                    <span className="link-to" title={link.toUrl}>
                                                        {shortenUrl(link.toUrl)}
                                                    </span>
                                        </div>
                                        <div className="link-meta">
                                                    <code className="link-selector">
                                                        {link.selector}
                                                    </code>
                                                    {link.linkText && (
                                                        <span className="link-text">
                                                            {link.linkText}
                                                        </span>
                                                    )}
                                        </div>
                                    </div>
                                        ))
                                    )}
                            </div>
                        )}

                        {resultsSubTab === "broken" && (
                            <div className="links-list">
                                    {brokenLinks.length === 0 ? (
                                        <p className="empty">No broken links detected.</p>
                                    ) : (
                                        brokenLinks.map((link, i) => (
                                    <div key={`b-${i}`} className="link-row broken">
                                        <div className="link-path">
                                                    <span
                                                        className="link-from"
                                                        title={link.fromUrl}
                                                    >
                                                        {shortenUrl(link.fromUrl)}
                                                    </span>
                                                    <svg
                                                        className="link-arrow"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                        aria-hidden="true"
                                                    >
                                                        <path d="M5 12h14m-4-4l4 4-4 4" />
                                                    </svg>
                                                    <span
                                                        className="link-to broken-url"
                                                        title={link.toUrl}
                                                    >
                                                        {shortenUrl(link.toUrl)}
                                                    </span>
                                        </div>
                                                {link.errorMessage && (
                                                    <span className="link-error">
                                                        {link.errorMessage}
                                                    </span>
                                                )}
                                    </div>
                                        ))
                                    )}
                            </div>
                        )}
                    </div>
                )}
                </div>
            </div>

            {toastMessage && (
                <div className="dv-toast">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                    >
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

// ---------------------------------------------------------------------------
// BlockerPanel — generic per-blocker UI
// ---------------------------------------------------------------------------

type BlockerCategory =
    | "auth_required"
    | "captcha"
    | "consent_wall"
    | "rate_limited"
    | "geo_blocked"
    | "interstitial"
    | "error_page"
    | "manual"
    | "unknown";

interface BlockerRow {
    id: number | null | undefined;
    url: string;
    category: BlockerCategory;
    severity: "pause" | "skip" | "log";
    detectorId?: string | null;
    blockerType?: string | null;
    evidenceJson?: string | null;
    screenshotPath?: string | null;
    discoveredAt: string | null;
}

interface BlockerPanelProps {
    blockers: BlockerRow[];
    onResolve: (
        blockerId: number,
        category: BlockerCategory,
        resolution: "clear" | "skip" | "ignore_category" | "provide_state",
    ) => void;
    onHandoff: (blockerId: number, category: BlockerCategory) => void;
    pendingBlockerId: number | null;
    pendingHandoffId: number | null;
    isPending: boolean;
    authAssistMessage?: string | null;
    authAssistCommand?: string | null;
}

const CATEGORY_LABELS: Record<BlockerCategory, string> = {
    auth_required: "Authentication required",
    captcha: "Captcha challenge",
    consent_wall: "Consent wall",
    rate_limited: "Rate limited",
    geo_blocked: "Geo blocked",
    interstitial: "Interstitial",
    error_page: "Error page",
    manual: "Paused by you",
    unknown: "Unknown blocker",
};

function BlockerPanel({
    blockers,
    onResolve,
    onHandoff,
    pendingBlockerId,
    pendingHandoffId,
    isPending,
    authAssistMessage,
    authAssistCommand,
}: BlockerPanelProps) {
    return (
        <section className="card blocker-panel" aria-label="Blockers">
            <h2 className="card-title">
                Blockers
                <span className="blocker-count">{blockers.length}</span>
            </h2>
            <p className="bp-help">
                Discovery paused. Resolve each blocker below, or click <strong>Continue</strong> at
                the top to clear them all.
            </p>

            {authAssistCommand && (
                <div className="bp-cli">
                    <span className="bp-cli-hint">Or from the terminal:</span>
                    <code>{authAssistCommand}</code>
                    {authAssistMessage && <span className="bp-cli-msg">{authAssistMessage}</span>}
                </div>
            )}

            <ul className="bp-list">
                {blockers.map((b) => (
                    <BlockerCard
                        key={b.id ?? `${b.url}-${b.detectorId ?? b.blockerType ?? "unknown"}`}
                        blocker={b}
                        onResolve={onResolve}
                        onHandoff={onHandoff}
                        isResolving={pendingBlockerId === b.id}
                        isHandoff={pendingHandoffId === b.id}
                        anyPending={isPending}
                    />
                ))}
            </ul>
        </section>
    );
}

interface BlockerCardProps {
    blocker: BlockerRow;
    onResolve: BlockerPanelProps["onResolve"];
    onHandoff: BlockerPanelProps["onHandoff"];
    isResolving: boolean;
    isHandoff: boolean;
    anyPending: boolean;
}

function BlockerCard({
    blocker,
    onResolve,
    onHandoff,
    isResolving,
    isHandoff,
    anyPending,
}: BlockerCardProps) {
    const id = blocker.id;
    const category = blocker.category;
    const evidence = useMemo(() => parseEvidence(blocker.evidenceJson), [blocker.evidenceJson]);
    const isManual = category === "manual";
    // Categories where the user almost certainly needs to drive a real
    // browser — clicking "I've handled it" without that does nothing useful
    // (the next request just re-trips the same detector). For these, the
    // handoff button is the primary CTA and the bare-clear button is
    // demoted to a secondary "I already handled it elsewhere" affordance.
    const needsBrowser =
        category === "auth_required" ||
        category === "captcha" ||
        category === "consent_wall" ||
        category === "interstitial";
    const handoffLabel =
        category === "auth_required"
            ? "Sign in via browser"
            : category === "captcha"
              ? "Solve captcha in browser"
              : category === "consent_wall"
                ? "Accept in browser"
                : "Open in browser";
    const clearLabel =
        category === "auth_required"
            ? "I already signed in elsewhere"
            : category === "captcha" || category === "consent_wall"
              ? "I already cleared it elsewhere"
              : "I've handled it — continue";
    const clearTitle =
        category === "auth_required"
            ? "Use only if you ran `raiken auth` (or otherwise produced an auth-state.json) in another window. We'll re-crawl from the start URL with the new state."
            : "Mark this blocker resolved and resume the crawl from this URL.";

    const handle = (resolution: "clear" | "skip" | "ignore_category") => {
        if (id == null) return;
        onResolve(id, category, resolution);
    };

    return (
        <li className={`bp-item bp-cat-${category}`}>
            <div className="bp-row">
                <span className={`bp-badge bp-badge-${category}`}>{CATEGORY_LABELS[category]}</span>
                <span className="bp-url" title={blocker.url}>
                    {blocker.url}
                </span>
                {blocker.discoveredAt && (
                    <time className="bp-time">
                        {new Date(blocker.discoveredAt).toLocaleTimeString()}
                    </time>
                )}
            </div>

            {evidence && (
                <pre className="bp-evidence" role="region" aria-label="Detector evidence">
                    {evidence}
                </pre>
            )}

            {needsBrowser && (
                <p className="bp-hint">
                    {category === "auth_required"
                        ? "We can't see this app's protected pages until you sign in. Open a browser, log in once, and we'll re-crawl from the start URL with your session."
                        : category === "captcha"
                          ? "Solve the challenge in a real browser; we'll capture the resulting cookies and resume."
                          : "Resolve in a real browser and we'll resume the crawl with the captured state."}
                </p>
            )}

            <div className="bp-actions">
                {needsBrowser && (
                    <button
                        type="button"
                        className="btn primary sm"
                        onClick={() => id != null && onHandoff(id, category)}
                        disabled={id == null || anyPending}
                        title="Open this URL in a real Chromium window. When you finish, we'll snapshot the cookies/localStorage and resume the crawl from the start URL."
                    >
                        {isHandoff ? "Browser open…" : handoffLabel}
                    </button>
                )}
                <button
                    type="button"
                    className={`btn sm${needsBrowser ? "" : " primary"}`}
                    onClick={() => handle("clear")}
                    disabled={id == null || anyPending}
                    title={clearTitle}
                >
                    {isResolving ? "Resuming…" : clearLabel}
                </button>
                {!isManual && (
                    <button
                        type="button"
                        className="btn sm"
                        onClick={() => handle("skip")}
                        disabled={id == null || anyPending}
                        title="Skip this URL and resume from the start URL."
                    >
                        Skip URL
                    </button>
                )}
                {!isManual && (
                    <button
                        type="button"
                        className="btn sm"
                        onClick={() => handle("ignore_category")}
                        disabled={id == null || anyPending}
                        title={`Don't pause for "${CATEGORY_LABELS[category]}" again this session.`}
                    >
                        Ignore this kind
                    </button>
                )}
                {!needsBrowser && category === "manual" && (
                    <button
                        type="button"
                        className="btn sm"
                        onClick={() => id != null && onHandoff(id, category)}
                        disabled={id == null || anyPending}
                        title="Open this URL in a real Chromium window."
                    >
                        {isHandoff ? "Browser open…" : "Open in browser"}
                    </button>
                )}
            </div>
        </li>
    );
}

function parseEvidence(evidenceJson: string | null | undefined): string | null {
    if (!evidenceJson) return null;
    try {
        const data = JSON.parse(evidenceJson);
        return JSON.stringify(data, null, 2);
    } catch {
        return evidenceJson;
    }
}

export default DiscoveryView;

const STYLES = `
    .discovery-view {
        display: flex; flex-direction: column; flex: 1;
        min-height: 0; background: var(--bg); color: var(--ink);
        font-family: var(--mono); overflow: hidden;
    }
    .view-body { display: flex; min-height: 0; flex: 1; overflow: hidden; }
    .view-shell { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }

    /* ── Tabs ── */
    .dv-tabs {
        display: flex; border-bottom: 1px solid var(--hair);
        padding: 0 0.75rem; flex-shrink: 0; background: var(--bg-bar);
        height: 34px; align-items: stretch;
    }
    .dv-tab {
        all: unset; padding: 0 0.75rem; font-size: 11.5px;
        font-family: var(--mono); color: var(--ink-faint);
        cursor: pointer; position: relative;
        display: flex; align-items: center; gap: 0.4rem;
    }
    .dv-tab:hover { color: var(--ink-dim); }
    .dv-tab.active { color: var(--ink); }
    .dv-tab.active::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
        height: 1px; background: var(--accent);
    }
    .dv-tab-badge {
        font-size: 10px; background: var(--bg); color: var(--ink-faint);
        border: 1px solid var(--hair); padding: 0 5px;
        min-width: 1.1rem; text-align: center;
        font-variant-numeric: tabular-nums;
    }
    .dv-tab.active .dv-tab-badge { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-soft); }

    .tab-content {
        display: flex; flex-direction: column; gap: 0.75rem;
        padding: 0.875rem; flex: 1; overflow-y: auto; min-height: 0;
        font-family: var(--mono);
    }

    /* ── Card ── */
    .card {
        border: 1px solid var(--hair); background: var(--bg-bar);
        display: flex; flex-direction: column; gap: 0.625rem;
        padding: 0.75rem 0.875rem;
    }
    .card-title {
        margin: 0; font-size: 10.5px; font-weight: 500;
        letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint);
        padding-bottom: 0.375rem; border-bottom: 1px solid var(--hair);
        display: flex; align-items: center; gap: 0.375rem;
    }
    .card-title::before { content: "#"; color: var(--accent); font-weight: 400; }
    .card-divider { border-top: 1px solid var(--hair); margin: 0.125rem 0; }

    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

    /* ── Fields ── */
    .field { display: flex; flex-direction: column; gap: 0.25rem; }
    .field-label {
        font-size: 10.5px; color: var(--ink-faint);
        text-transform: uppercase; letter-spacing: 0.04em;
    }

    .discovery-view input[type="text"],
    .discovery-view input:not([type]),
    .discovery-view textarea {
        background: var(--bg); border: 1px solid var(--hair-strong); border-radius: 0;
        color: var(--ink); padding: 0.375rem 0.5rem; font-size: 12px;
        font-family: var(--mono);
    }
    .discovery-view input:focus,
    .discovery-view textarea:focus { border-color: var(--accent); outline: none; }

    .url-row { display: flex; gap: 0.25rem; }
    .url-row input { flex: 1; }
    .url-open {
        display: flex; align-items: center; justify-content: center;
        width: 1.875rem; flex-shrink: 0; background: var(--bg);
        border: 1px solid var(--hair-strong); color: var(--ink-faint);
        text-decoration: none; transition: color 0.12s, border-color 0.12s;
    }
    .url-open:hover { color: var(--accent); border-color: var(--accent-dim); }
    .url-open svg { width: 0.75rem; height: 0.75rem; }

    .field-row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }

    /* ── Toggle ── */
    .options-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .toggle { display: flex; align-items: center; gap: 0.4375rem; cursor: pointer; }
    .toggle-track {
        width: 26px; height: 14px; background: var(--hair-strong);
        position: relative; transition: background 0.15s; flex-shrink: 0;
    }
    .toggle-track.on { background: var(--accent); }
    .toggle-thumb {
        position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
        background: var(--bg); transition: transform 0.15s;
    }
    .toggle-track.on .toggle-thumb { transform: translateX(12px); background: var(--bg); }
    .toggle-label { font-size: 11.5px; color: var(--ink-dim); user-select: none; }

    /* ── Exclude tags ── */
    .exclude-section { display: flex; flex-direction: column; gap: 0.3125rem; }
    .tags-wrap {
        display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center;
        padding: 0.3125rem 0.4375rem; background: var(--bg);
        border: 1px solid var(--hair-strong);
        min-height: 1.75rem;
    }
    .tag {
        display: inline-flex; align-items: center; gap: 0.25rem;
        padding: 1px 5px; background: var(--bg-bar); border: 1px solid var(--hair-strong);
        font-size: 11px; color: var(--accent);
        font-family: var(--mono);
    }
    .tag-x {
        all: unset; cursor: pointer; font-size: 11px; line-height: 1;
        color: var(--ink-faint); padding: 0 2px;
    }
    .tag-x:hover { color: var(--fail); }
    .tag-input {
        all: unset; flex: 1; min-width: 80px; font-size: 11.5px;
        color: var(--ink); padding: 1px 0; font-family: var(--mono);
    }
    .tag-input::placeholder { color: var(--ink-faint); }

    /* ── Action bar ── */
    .action-bar { display: flex; gap: 0.375rem; flex-wrap: wrap; padding-top: 0.125rem; }

    .btn {
        padding: 0.3125rem 0.625rem; border: 1px solid var(--hair-strong);
        background: var(--bg); color: var(--ink);
        font-size: 11.5px; font-family: var(--mono); cursor: pointer;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--ink-faint); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn.primary {
        background: transparent; border-color: var(--accent-dim); color: var(--accent);
    }
    .btn.primary:hover:not(:disabled) {
        background: var(--accent-dim); border-color: var(--accent);
    }
    .btn.danger {
        background: transparent; border-color: rgba(215, 92, 92, 0.3); color: var(--fail);
    }
    .btn.danger:hover:not(:disabled) { background: var(--fail-soft); border-color: var(--fail); }
    .btn.sm { padding: 0.1875rem 0.4375rem; font-size: 10.5px; }

    .error-banner {
        background: var(--fail-soft); border: 1px solid rgba(215, 92, 92, 0.3);
        border-left-width: 2px; color: var(--ink);
        padding: 0.4375rem 0.625rem; font-size: 11.5px; font-family: var(--mono);
    }
    .error-banner strong { color: var(--fail); }

    /* ── Progress ── */
    .progress-bar-wrap {
        position: relative; height: 1.25rem; background: var(--bg-bar);
        border: 1px solid var(--hair); overflow: hidden;
    }
    .progress-bar {
        position: absolute; inset: 0; right: auto;
        background: var(--accent-dim);
        border-right: 1px solid var(--accent);
        transition: width 0.6s ease;
    }
    .progress-label {
        position: relative; z-index: 1; display: flex; align-items: center;
        justify-content: center; height: 100%; font-size: 11px;
        color: var(--ink); font-family: var(--mono); font-variant-numeric: tabular-nums;
    }

    /* ── Banners ── */
    .banner {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.4375rem 0.625rem;
        font-size: 11.5px; border: 1px solid var(--hair);
        border-left-width: 2px; font-family: var(--mono);
    }
    .banner svg { width: 0.875rem; height: 0.875rem; flex-shrink: 0; }
    .banner span { flex: 1; }
    .banner-close {
        all: unset; cursor: pointer; font-size: 14px; line-height: 1;
        color: inherit; opacity: 0.6; padding: 0 0.25rem;
    }
    .banner-close:hover { opacity: 1; }
    .banner-success { background: var(--pass-soft); border-color: rgba(111, 184, 111, 0.3); color: var(--pass); }
    .banner-warn { background: var(--warn-soft); border-color: rgba(217, 164, 65, 0.3); color: var(--warn); }
    .banner-auth {
        flex-direction: column; align-items: flex-start;
        background: var(--warn-soft); border-color: rgba(217, 164, 65, 0.3);
        color: var(--ink); padding: 0.5rem 0.625rem; gap: 0.3125rem;
    }
    .banner-auth strong { color: var(--warn); }
    .banner-auth code {
        display: inline-block; background: var(--bg); padding: 0.25rem 0.4375rem;
        border: 1px solid var(--hair); font-size: 11px;
        font-family: var(--mono); color: var(--accent);
    }

    /* ── Stat Grid ── */
    .stat-grid {
        display: grid; grid-template-columns: repeat(6, 1fr); gap: 0;
        border: 1px solid var(--hair); background: var(--bg);
    }
    .stat {
        display: flex; flex-direction: column; gap: 0.125rem;
        padding: 0.5rem 0.625rem; text-align: left;
    }
    .stat + .stat { border-left: 1px solid var(--hair); }
    .stat-label {
        font-size: 10px; color: var(--ink-faint);
        text-transform: uppercase; letter-spacing: 0.04em;
    }
    .stat-value {
        font-size: 14px; font-weight: 500; color: var(--ink);
        font-variant-numeric: tabular-nums; font-family: var(--mono);
    }
    .clr-ok { color: var(--pass); }
    .clr-err { color: var(--fail); }
    .clr-warn { color: var(--warn); }
    .phase-running { color: var(--pass); }
    .phase-running::before { content: "● "; }
    .phase-paused { color: var(--warn); }
    .phase-paused::before { content: "◐ "; }
    .phase-error { color: var(--fail); }
    .phase-error::before { content: "✕ "; }
    .phase-completed { color: var(--info); }
    .phase-completed::before { content: "✓ "; }
    .phase-idle { color: var(--ink-faint); }
    .phase-idle::before { content: "○ "; }

    /* ── Session strip ── */
    .session-strip {
        display: flex; flex-wrap: wrap; gap: 0.5rem 1rem;
        padding-top: 0.5rem; border-top: 1px solid var(--hair);
        font-size: 11.5px; color: var(--ink);
    }
    .session-kv { display: flex; gap: 0.25rem; align-items: center; }
    .session-k { color: var(--ink-faint); }
    .session-k::after { content: "="; margin-left: 2px; color: var(--ink-mute); }
    .session-url {
        max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--accent);
    }

    /* ── Timeline ── */
    .timeline { display: flex; flex-direction: column; max-height: 240px; overflow-y: auto; }
    .tl-event { padding: 0.375rem 0; }
    .tl-event + .tl-event { border-top: 1px solid var(--hair-soft); }
    .tl-top { display: flex; justify-content: space-between; align-items: center; }
    .tl-type {
        font-size: 11px; font-weight: 500; color: var(--accent);
        font-family: var(--mono);
    }
    .tl-type::before { content: "["; color: var(--ink-mute); }
    .tl-type::after { content: "]"; color: var(--ink-mute); }
    .tl-time { font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
    .tl-msg { margin: 0.1875rem 0 0; font-size: 11.5px; color: var(--ink-dim); }

    .blocker-header {
        display: flex; align-items: center; gap: 0.4375rem;
        font-size: 11px; font-weight: 500; color: var(--ink-faint);
        text-transform: uppercase; letter-spacing: 0.04em;
    }
    .blocker-count {
        font-size: 10px; background: var(--fail-soft); color: var(--fail);
        border: 1px solid rgba(215, 92, 92, 0.3);
        padding: 0 5px; font-variant-numeric: tabular-nums;
    }

    /* ── Tables ── */
    .table-wrap { overflow: auto; max-height: 440px; border: 1px solid var(--hair); }
    table {
        width: 100%; border-collapse: collapse;
        font-size: 11.5px; font-family: var(--mono);
    }
    th, td {
        border-bottom: 1px solid var(--hair-soft); text-align: left;
        padding: 0.375rem 0.5rem;
    }
    th {
        color: var(--ink-faint); font-weight: 500; font-size: 10.5px;
        text-transform: uppercase; letter-spacing: 0.04em;
        position: sticky; top: 0; background: var(--bg-bar);
        border-bottom: 1px solid var(--hair);
    }
    td { color: var(--ink); }
    tbody tr:hover td { background: var(--bg-hover); }
    .url-cell {
        max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--accent);
    }
    .empty, .empty-cell {
        color: var(--ink-faint); font-size: 11.5px; font-style: normal;
    }
    .empty-cell { text-align: center; padding: 1rem !important; }
    .page-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
    .table-action {
        all: unset; padding: 2px 6px; border: 1px solid var(--hair-strong);
        background: var(--bg); color: var(--ink-dim);
        font-size: 10.5px; cursor: pointer; text-decoration: none;
        display: inline-flex; align-items: center; font-family: var(--mono);
    }
    .table-action:hover { background: var(--bg-hover); color: var(--ink); }
    a.table-link {
        all: revert;
        padding: 2px 6px; border: 1px solid var(--hair-strong);
        background: var(--bg); color: var(--ink-dim);
        font-size: 10.5px; cursor: pointer; text-decoration: none;
        display: inline-flex; align-items: center; box-sizing: border-box;
        font-family: var(--mono);
    }
    a.table-link:hover { background: var(--bg-hover); color: var(--ink); }
    .table-action.generate {
        background: transparent; border-color: var(--accent-dim); color: var(--accent);
    }
    .table-action.generate:hover { background: var(--accent-dim); }

    .pagination {
        display: flex; align-items: center; justify-content: center;
        gap: 0.625rem; padding-top: 0.4375rem; border-top: 1px solid var(--hair);
    }
    .page-info {
        font-size: 11px; color: var(--ink-faint);
        font-variant-numeric: tabular-nums;
    }

    /* ── Snapshot ── */
    .snapshot-drawer {
        display: flex; flex-direction: column; gap: 0.4375rem;
        margin-top: 0.625rem; padding-top: 0.625rem;
        border-top: 1px solid var(--hair);
    }
    .snapshot-bar { display: flex; align-items: center; justify-content: space-between; }
    .snapshot-title {
        font-size: 11.5px; font-weight: 500; color: var(--accent);
        text-transform: lowercase;
    }
    .snapshot-title::before { content: "$ "; color: var(--ink-mute); }
    .snapshot-close {
        all: unset; cursor: pointer; font-size: 14px; line-height: 1;
        color: var(--ink-faint); padding: 0 0.25rem;
    }
    .snapshot-close:hover { color: var(--ink); }
    .snapshot-meta {
        display: flex; flex-wrap: wrap; gap: 0.625rem;
        font-size: 11px; color: var(--ink-faint);
    }
    .snapshot-pre {
        margin: 0; padding: 0.5rem 0.625rem;
        border: 1px solid var(--hair); background: var(--bg-sunken);
        color: var(--ink); font-size: 11px; line-height: 1.5;
        overflow: auto; max-height: 320px; white-space: pre-wrap; word-break: break-word;
        font-family: var(--mono);
    }

    /* ── Results sub-tabs ── */
    .results-sub-tabs {
        display: flex; border-bottom: 1px solid var(--hair);
        margin: -0.875rem -0.875rem 0; padding: 0 0.875rem;
        background: var(--bg-bar);
    }
    .results-sub-tab {
        all: unset; padding: 0.4375rem 0.75rem; font-size: 11.5px;
        color: var(--ink-faint); cursor: pointer;
        position: relative;
        display: flex; align-items: center; gap: 0.3125rem;
        font-family: var(--mono);
    }
    .results-sub-tab:hover { color: var(--ink-dim); }
    .results-sub-tab.active { color: var(--ink); }
    .results-sub-tab.active::after {
        content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
        height: 1px; background: var(--accent);
    }
    .sub-badge {
        font-size: 10px; background: var(--bg); color: var(--ink-faint);
        border: 1px solid var(--hair); padding: 0 5px;
        min-width: 14px; text-align: center; font-variant-numeric: tabular-nums;
    }
    .sub-badge.good { border-color: rgba(111, 184, 111, 0.3); color: var(--pass); background: var(--pass-soft); }
    .sub-badge.bad { border-color: rgba(215, 92, 92, 0.3); color: var(--fail); background: var(--fail-soft); }
    .results-sub-tab.active .sub-badge { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-soft); }

    .dv-section { display: flex; flex-direction: column; gap: 0.625rem; }

    /* ── Links ── */
    .links-list { flex: 1; overflow-y: auto; min-height: 0; }
    .link-row {
        padding: 0.4375rem 0.5rem;
        border-bottom: 1px solid var(--hair-soft);
        font-family: var(--mono);
    }
    .link-row:hover { background: var(--bg-hover); }
    .link-row.broken { border-left: 2px solid var(--fail); }
    .link-path { display: flex; align-items: center; gap: 0.4375rem; font-size: 11.5px; }
    .link-from, .link-to { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link-from { color: var(--ink-faint); max-width: 40%; }
    .link-to { color: var(--ink); flex: 1; min-width: 0; }
    .link-to.broken-url { color: var(--fail); text-decoration: line-through; }
    .link-arrow { width: 0.75rem; height: 0.75rem; color: var(--ink-mute); flex-shrink: 0; }
    .link-meta { display: flex; align-items: center; gap: 0.4375rem; margin-top: 0.1875rem; flex-wrap: wrap; }
    .link-selector {
        font-size: 10.5px; color: var(--accent);
        background: var(--accent-soft); border: 1px solid var(--accent-dim);
        padding: 1px 5px; font-family: var(--mono);
    }
    .link-text { font-size: 10.5px; color: var(--ink-faint); }
    .link-error { display: block; margin-top: 0.1875rem; font-size: 10.5px; color: var(--fail); }

    /* ── Toast ── */
    .dv-toast {
        position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 0.4375rem;
        padding: 0.4375rem 0.75rem;
        background: var(--bg-bar); color: var(--ink);
        border: 1px solid var(--accent-dim); border-left-width: 2px;
        border-left-color: var(--accent);
        font-size: 11.5px; font-family: var(--mono);
        box-shadow: 0 8px 24px rgba(0,0,0,.5);
        animation: dv-toast-in 0.25s ease-out;
        z-index: 1000; max-width: 90vw;
    }
    .dv-toast svg { width: 0.875rem; height: 0.875rem; flex-shrink: 0; color: var(--accent); }
    @keyframes dv-toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(8px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    /* ── BlockerPanel ── */
    .blocker-panel { border-left: 2px solid var(--warn); }
    .blocker-panel .card-title { display: flex; align-items: center; gap: 0.4375rem; }
    .bp-help {
        margin: 0; font-size: 11.5px; color: var(--ink-dim);
    }
    .bp-help strong { color: var(--ink); }
    .bp-cli {
        display: flex; flex-wrap: wrap; align-items: center; gap: 0.4375rem;
        padding: 0.375rem 0.5rem; background: var(--bg);
        border: 1px solid var(--hair); font-size: 11px;
    }
    .bp-cli-hint { color: var(--ink-faint); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
    .bp-cli code {
        background: var(--bg-bar); padding: 0.1875rem 0.375rem;
        border: 1px solid var(--hair-strong); color: var(--accent);
        font-family: var(--mono); font-size: 11px;
    }
    .bp-cli-msg { color: var(--ink-faint); flex: 1; min-width: 0; }
    .bp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4375rem; }
    .bp-item {
        display: flex; flex-direction: column; gap: 0.375rem;
        padding: 0.5rem 0.625rem; background: var(--bg);
        border: 1px solid var(--hair); border-left-width: 2px;
        border-left-color: var(--hair-strong);
    }
    .bp-cat-auth_required { border-left-color: var(--warn); }
    .bp-cat-captcha { border-left-color: var(--accent); }
    .bp-cat-consent_wall { border-left-color: var(--info, var(--accent)); }
    .bp-cat-rate_limited { border-left-color: var(--warn); }
    .bp-cat-error_page { border-left-color: var(--fail); }
    .bp-cat-manual { border-left-color: var(--ink-faint); }
    .bp-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .bp-badge {
        display: inline-flex; align-items: center; padding: 1px 6px;
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
        border: 1px solid var(--hair-strong); background: var(--bg-bar);
        color: var(--ink-dim); font-family: var(--mono);
    }
    .bp-badge-auth_required { border-color: rgba(217, 164, 65, 0.4); color: var(--warn); background: var(--warn-soft); }
    .bp-badge-captcha { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-soft); }
    .bp-badge-consent_wall { border-color: var(--accent-dim); color: var(--accent); background: var(--accent-soft); }
    .bp-badge-rate_limited { border-color: rgba(217, 164, 65, 0.4); color: var(--warn); background: var(--warn-soft); }
    .bp-badge-error_page { border-color: rgba(215, 92, 92, 0.4); color: var(--fail); background: var(--fail-soft); }
    .bp-badge-manual { border-color: var(--hair-strong); color: var(--ink-faint); }
    .bp-url {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--accent); font-size: 11.5px;
    }
    .bp-time { font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
    .bp-evidence {
        margin: 0; padding: 0.375rem 0.5rem;
        max-height: 120px; overflow: auto;
        background: var(--bg-bar); border: 1px solid var(--hair-soft);
        font-size: 10.5px; color: var(--ink-dim); font-family: var(--mono);
        white-space: pre-wrap; word-break: break-word;
    }
    .bp-hint {
        margin: 0.25rem 0 0;
        font-size: 0.78rem;
        line-height: 1.35;
        color: var(--text-muted, #94a3b8);
    }
    .bp-actions { display: flex; flex-wrap: wrap; gap: 0.375rem; }

    /* ── Responsive ── */
    @media (max-width: 900px) {
        .field-row-3 { grid-template-columns: 1fr 1fr; }
        .stat-grid { grid-template-columns: repeat(3, 1fr); }
        .stat + .stat:nth-child(4) { border-left: none; }
        .stat:nth-child(n+4) { border-top: 1px solid var(--hair); }
    }
    @media (max-width: 600px) {
        .field-row-3 { grid-template-columns: 1fr; }
        .stat-grid { grid-template-columns: repeat(2, 1fr); }
    }
`;
