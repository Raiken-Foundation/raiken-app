import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "../components/command-palette";
import { NavRail } from "../components/nav-rail";
import { trpc } from "../utils/trpc";
import { BoardScreen } from "./board";
import {
    ConnectionDegraded,
    ConnectionError,
    ConnectionNotReady,
    deriveConnectionFlags,
} from "./connection-status";
// `TestingView` is *not* lazy because it stays mounted across navigation so
// editor state (open files, unsaved buffers, a run in flight) survives view
// toggles. See `app-shell.testing` below — TestingView is rendered
// unconditionally and toggled via display:none rather than conditional
// rendering.
import { TestingView } from "./testing-view";

const QualityView = lazy(() => import("./quality-view").then((m) => ({ default: m.QualityView })));
const ContractView = lazy(() => import("./contract").then((m) => ({ default: m.ContractView })));

/**
 * Views: the board (the Reader's landing screen) plus the workbench views
 * (contract / testing / quality) grouped behind one rail entry. The front
 * door is the board; the workbench is one click behind it.
 */
type View = "board" | "contract" | "testing" | "quality";

const WORKBENCH_VIEWS = ["contract", "testing", "quality"] as const;
type WorkbenchView = (typeof WORKBENCH_VIEWS)[number];

function isWorkbenchView(value: string): value is WorkbenchView {
    return (WORKBENCH_VIEWS as readonly string[]).includes(value);
}

function getViewFromHash(): View {
    // The board is the landing view: an empty or unknown hash opens it.
    // Deep links into the workbench (`#/contract/acquisition`, legacy
    // `#/discovery`) keep working — the first hash segment routes the view,
    // the rest is each screen's own state.
    const seg = window.location.hash.match(/^#\/([a-z]+)/)?.[1];
    if (seg === "board") return "board";
    if (seg === "discovery") return "contract";
    if (isWorkbenchView(seg ?? "")) return seg as WorkbenchView;
    return "board";
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

// Attention badges are cheap "does anything need a look" checks, not
// realtime telemetry — a slow 30s poll keeps the nav rail honest without
// adding meaningful load, matching the getHealth poll below.
const ATTENTION_POLL_MS = 30000;

export function App() {
    const [currentView, setCurrentView] = useState<View>(getViewFromHash);
    // The last workbench view the operator used — the Workbench rail button
    // returns there instead of resetting to a default.
    const lastWorkbenchView = useRef<WorkbenchView>("contract");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [pendingGeneratedTest, setPendingGeneratedTest] = useState<string | undefined>();

    const healthQuery = trpc.getHealth.useQuery(undefined, {
        retry: 2,
        retryDelay: 1000,
        refetchInterval: 30000,
    });
    const { isBackendDown, isBackendNotReady, isBackendDegraded } = deriveConnectionFlags({
        isError: healthQuery.isError,
        data: healthQuery.data,
    });

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
        if (view !== "board") lastWorkbenchView.current = view as WorkbenchView;
        setCurrentView(view);
        window.location.hash = view === "board" ? "#/board" : `#/${view}`;
    }, []);

    useEffect(() => {
        const onHashChange = () => setCurrentView(getViewFromHash());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    const handleNavigate = (view: View) => {
        navigateTo(view);
    };

    // Discovery "generate test" handoff, post-chat: instead of seeding a
    // composer prompt, save a real runnable smoke spec for the page and open
    // the editor with it. Anything richer is `raiken cover` (quality view).
    const handleGenerateTest = (pageUrl: string) => {
        const slug =
            pageUrl
                .replace(/^https?:\/\//, "")
                .replace(/[^a-z0-9]+/gi, "-")
                .replace(/^-|-$/g, "")
                .toLowerCase() || "page";
        const template = `import { test, expect } from "@playwright/test";

test.describe("discovered page ${slug}", () => {
    test("loads and renders", async ({ page }) => {
        await page.goto("${pageUrl}");
        await expect(page.locator("body")).toBeVisible();
    });
});
`;
        setPendingGeneratedTest(template);
        setSidebarCollapsed(false);
        navigateTo("testing");
    };

    return (
        <div className="app-shell">
            {/* First tab stop: keyboard users skip the rail and banners. */}
            <a className="skip-link" href="#app-content">
                Skip to content
            </a>
            <CommandPalette onNavigate={(v) => handleNavigate(v)} />
            {isBackendDown && <ConnectionError />}
            {isBackendNotReady && (
                <ConnectionNotReady
                    checks={healthQuery.data?.checks as Record<string, string> | undefined}
                />
            )}
            {/*
              Degraded = optional capabilities (AI, etc.) are limited. Nothing
              on the board depends on them — verification is deterministic —
              and "ai: degraded" is jargon on the Reader's screen, where on a
              narrow viewport it also overlapped a row. Backend-down and
              not-ready still surface everywhere: those really do stop the
              board from working.
            */}
            {isBackendDegraded && currentView !== "board" && (
                <ConnectionDegraded
                    checks={healthQuery.data?.checks as Record<string, string> | undefined}
                />
            )}
            <NavRail
                activeView={currentView === "board" ? "board" : "workbench"}
                workbenchView={currentView === "board" ? lastWorkbenchView.current : currentView}
                onOpenWorkbench={() => navigateTo(lastWorkbenchView.current)}
                onNavigate={handleNavigate}
                sidebarCollapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
                attention={{
                    files: anyTestBroken,
                    discovery: discoveryNeedsAttention,
                }}
            />

            <div className="app-main" id="app-content">
                {currentView === "board" ? (
                    <BoardScreen />
                ) : (
                    <div className="app-workbench">
                        {/* One h1 per screen: heading navigation anchors the
                            workbench without restyling each view's layout. */}
                        <h1 className="sr-only">Workbench</h1>
                        <nav className="workbench-tabs" aria-label="Workbench views">
                            {WORKBENCH_VIEWS.map((view) => {
                                const isActive = currentView === view;
                                return (
                                    <button
                                        key={view}
                                        type="button"
                                        className={`workbench-tab ${isActive ? "is-active" : ""}`}
                                        aria-current={isActive ? "page" : undefined}
                                        onClick={() => navigateTo(view)}
                                    >
                                        {view === "contract"
                                            ? "Contract"
                                            : view === "testing"
                                              ? "Tests"
                                              : "Quality"}
                                    </button>
                                );
                            })}
                            <a className="workbench-board-link" href="#/board">
                                ← Board
                            </a>
                        </nav>
                        <div className="app-workbench-body">
                            {/*
                              TestingView is always mounted; we toggle visibility with
                              display:none so the editor's React state (open files, unsaved
                              buffers, a run in flight) survives a round-trip to another
                              view.
                            */}
                            <div className="app-view" data-active={currentView === "testing"}>
                                <TestingView
                                    sidebarCollapsed={sidebarCollapsed}
                                    pendingGeneratedTest={pendingGeneratedTest}
                                    onGeneratedTestConsumed={() =>
                                        setPendingGeneratedTest(undefined)
                                    }
                                />
                            </div>

                            <Suspense fallback={<ViewLoader />}>
                                {currentView === "quality" && <QualityView />}

                                {currentView === "contract" && (
                                    <ContractView onGenerateTest={handleGenerateTest} />
                                )}
                            </Suspense>
                        </div>
                    </div>
                )}
            </div>

            <style>{`
                .app-shell {
                    display: flex;
                    height: 100vh;
                    background: var(--bg);
                    color: var(--ink);
                    overflow: hidden;
                }
                .skip-link {
                    position: absolute;
                    left: -9999px;
                    top: 0;
                    background: var(--bg-elev);
                    color: var(--ink);
                    border: 1px solid var(--accent);
                    border-radius: 4px;
                    padding: 0.5rem 0.9rem;
                    font-size: 0.85rem;
                    z-index: 10000;
                }
                .skip-link:focus {
                    left: 0.75rem;
                    top: 0.75rem;
                }
                .sr-only {
                    position: absolute;
                    width: 1px;
                    height: 1px;
                    margin: -1px;
                    padding: 0;
                    overflow: hidden;
                    clip: rect(0 0 0 0);
                    white-space: nowrap;
                    border: 0;
                }
                .app-main {
                    display: flex;
                    flex: 1;
                    min-width: 0;
                }
                .app-workbench {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-width: 0;
                }
                .workbench-tabs {
                    display: flex;
                    align-items: center;
                    gap: 0.25rem;
                    padding: 0.5rem 1.25rem 0;
                    border-bottom: 1px solid var(--hair);
                }
                .workbench-tab {
                    background: transparent;
                    border: 0;
                    border-bottom: 2px solid transparent;
                    color: var(--ink-dim);
                    font-family: var(--mono);
                    font-size: 0.82rem;
                    padding: 0.5rem 0.9rem;
                    cursor: pointer;
                }
                .workbench-tab.is-active {
                    color: var(--ink);
                    border-bottom-color: var(--accent);
                }
                .workbench-board-link {
                    margin-left: auto;
                    color: var(--accent);
                    font-size: 0.8rem;
                    text-decoration: none;
                }
                .app-workbench-body {
                    display: flex;
                    flex: 1;
                    min-height: 0;
                    min-width: 0;
                }
                /* TestingView occupies the full available width when
                 * active and is collapsed to zero (but kept mounted)
                 * when another view is showing. We use display:none on
                 * the wrapper so the entire subtree is removed from
                 * layout and a11y trees, but React state (open files,
                 * unsaved buffers, a run in flight) survives. */
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
