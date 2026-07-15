import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { NavRail } from "../components/nav-rail";
import type { DashboardRoute } from "../utils/slash-commands";
import { trpc } from "../utils/trpc";
// `TestingView` is *not* lazy because it owns the chat sidebar, and we
// need to keep that subtree mounted across navigation. If we lazy-load
// it, the very first nav to `#/discovery` (without TestingView ever
// mounting) means the chat sidebar has nowhere to live, and we lose the
// "I'll come back to my chat thread later" UX. See `app-shell.testing`
// below — TestingView is rendered unconditionally and toggled via
// display:none rather than conditional rendering.
import { TestingView } from "./testing-view";

const DiscoveryView = lazy(() =>
    import("./discovery-view").then((m) => ({ default: m.DiscoveryView })),
);
const QualityView = lazy(() => import("./quality-view").then((m) => ({ default: m.QualityView })));
const SettingsView = lazy(() =>
    import("./settings-view").then((m) => ({ default: m.SettingsView })),
);

type View = "testing" | "discovery" | "quality" | "settings";
type SidebarTab = "chat" | "files";

const VIEWS = ["testing", "discovery", "quality", "settings"] as const;

function getViewFromHash(): View {
    // Match the first hash segment so deep-links like #/quality/doctor still
    // resolve to the parent view (#/quality) rather than the default fallback.
    const seg = window.location.hash.match(/^#\/([a-z]+)/)?.[1];
    return (VIEWS as readonly string[]).includes(seg ?? "") ? (seg as View) : "testing";
}

function ViewLoader() {
    return (
        <div className="view-loader">
            <span className="q-spin q-spin--lg" aria-hidden="true" />
            <style>{`
                .view-loader {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex: 1;
                    background: var(--bg);
                }
            `}</style>
        </div>
    );
}

function ConnectionError() {
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

// Attention badges are cheap "does anything need a look" checks, not
// realtime telemetry — a slow 30s poll keeps the nav rail honest without
// adding meaningful load, matching the getHealth poll below.
const ATTENTION_POLL_MS = 30000;

export function App() {
    const [currentView, setCurrentView] = useState<View>(getViewFromHash);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chat");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [pendingTestPrompt, setPendingTestPrompt] = useState<string | undefined>();
    const [hitlPending, setHitlPending] = useState(false);

    const healthQuery = trpc.getHealth.useQuery(undefined, {
        retry: 2,
        retryDelay: 1000,
        refetchInterval: 30000,
    });
    const isBackendDown = healthQuery.isError;

    // Nav-rail attention dots — the same "don't make the user go hunting for
    // what needs them" idea as the REPL's startup banner, just live-updating
    // instead of a one-shot message. Each query degrades independently (a
    // fresh project with no discovery DB yet just resolves to "nothing to
    // flag" server-side) so one failing check can't blank out the others.
    const discoverySessionQuery = trpc.getDiscoverySession.useQuery(
        {},
        { refetchInterval: ATTENTION_POLL_MS, refetchOnWindowFocus: false },
    );
    const discoveryStatsQuery = trpc.getDiscoveryStats.useQuery(
        {},
        { refetchInterval: ATTENTION_POLL_MS, refetchOnWindowFocus: false },
    );
    const testFilesQuery = trpc.listTestFiles.useQuery(
        {},
        { refetchInterval: ATTENTION_POLL_MS, refetchOnWindowFocus: false },
    );

    const discoveryNeedsAttention =
        discoverySessionQuery.data?.status === "paused" ||
        discoverySessionQuery.data?.status === "failed" ||
        (discoveryStatsQuery.data?.unresolvedBlockersCount ?? 0) > 0;

    const anyTestBroken = (testFilesQuery.data?.files ?? []).some((f) => f.status === "broken");

    const navigateTo = useCallback((view: View) => {
        setCurrentView(view);
        window.location.hash = `#/${view}`;
    }, []);

    useEffect(() => {
        const onHashChange = () => setCurrentView(getViewFromHash());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    const handleNavigate = (view: View, tab?: SidebarTab) => {
        if (view === "testing" && tab) {
            setSidebarTab(tab);
            if (sidebarCollapsed) setSidebarCollapsed(false);
        }
        navigateTo(view);
    };

    const handleGenerateTest = (pageUrl: string) => {
        setPendingTestPrompt(`Generate E2E tests for ${pageUrl}`);
        setSidebarTab("chat");
        if (sidebarCollapsed) setSidebarCollapsed(false);
        navigateTo("testing");
    };

    const handleSlashRoute = useCallback(
        (route: DashboardRoute) => {
            if (route.view === "testing") {
                if (route.tab) {
                    setSidebarTab(route.tab);
                    if (sidebarCollapsed) setSidebarCollapsed(false);
                }
                navigateTo("testing");
                return;
            }
            if (route.view === "quality" && route.tool) {
                setCurrentView("quality");
                window.location.hash = `#/quality/${route.tool}`;
                return;
            }
            navigateTo(route.view);
        },
        [navigateTo, sidebarCollapsed],
    );

    return (
        <div className="app-shell">
            {isBackendDown && <ConnectionError />}
            <NavRail
                activeView={currentView}
                activeSidebarTab={sidebarTab}
                sidebarCollapsed={sidebarCollapsed}
                onNavigate={handleNavigate}
                onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
                attention={{
                    chat: hitlPending,
                    files: anyTestBroken,
                    discovery: discoveryNeedsAttention,
                }}
            />

            {/*
              TestingView is always mounted; we toggle visibility with
              display:none so the chat sidebar's React state (in-flight
              streams, pending HITL approval, locally-rendered messages
              that haven't been persisted yet) survives a round-trip to
              another view. Conditional rendering would unmount the
              sidebar and abort the streaming fetch — the symptom users
              report as "I navigated to discovery, came back, and my
              message thread was gone".
            */}
            <div className="app-view" data-active={currentView === "testing"}>
                <TestingView
                    sidebarTab={sidebarTab}
                    sidebarCollapsed={sidebarCollapsed}
                    onSidebarTabChange={setSidebarTab}
                    pendingPrompt={pendingTestPrompt}
                    onPromptConsumed={() => setPendingTestPrompt(undefined)}
                    onNavigateRoute={handleSlashRoute}
                    onHitlPendingChange={setHitlPending}
                />
            </div>

            <Suspense fallback={<ViewLoader />}>
                {currentView === "discovery" && (
                    <DiscoveryView onGenerateTest={handleGenerateTest} />
                )}

                {currentView === "quality" && <QualityView />}

                {currentView === "settings" && <SettingsView />}
            </Suspense>

            <style>{`
                .app-shell {
                    display: flex;
                    height: 100vh;
                    background: var(--bg);
                    color: var(--ink);
                    overflow: hidden;
                }
                /* TestingView occupies the full available width when
                 * active and is collapsed to zero (but kept mounted)
                 * when another view is showing. We use display:none on
                 * the wrapper so the entire subtree is removed from
                 * layout and a11y trees, but React state and any
                 * in-flight effects (streaming chat fetches, HITL
                 * approval timers) survive untouched. */
                .app-view {
                    display: flex;
                    flex: 1;
                    min-width: 0;
                }
                .app-view[data-active="false"] {
                    display: none;
                }
            `}</style>
        </div>
    );
}

export default App;
