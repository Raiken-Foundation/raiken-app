import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { CommandPalette } from "../components/command-palette";
import { NavRail } from "../components/nav-rail";
import { trpc } from "../utils/trpc";
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
const ContractView = lazy(() =>
    import("./contract").then((m) => ({ default: m.ContractView })),
);

type View = "contract" | "testing" | "quality";

const VIEWS = ["contract", "testing", "quality"] as const;

function getViewFromHash(): View {
    // Match the first hash segment so deep-links like #/quality/doctor still
    // resolve to the parent view (#/quality). The contract is the product —
    // it's the landing view, not the editor. Discovery is folded into the
    // contract as its acquisition tab: legacy #/discovery links land there.
    const seg = window.location.hash.match(/^#\/([a-z]+)/)?.[1];
    if (seg === "discovery") return "contract";
    return (VIEWS as readonly string[]).includes(seg ?? "") ? (seg as View) : "contract";
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
        setCurrentView(view);
        window.location.hash = `#/${view}`;
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
            <CommandPalette onNavigate={(v) => handleNavigate(v)} />
            {isBackendDown && <ConnectionError />}
            {isBackendNotReady && (
                <ConnectionNotReady
                    checks={healthQuery.data?.checks as Record<string, string> | undefined}
                />
            )}
            {isBackendDegraded && (
                <ConnectionDegraded
                    checks={healthQuery.data?.checks as Record<string, string> | undefined}
                />
            )}
            <NavRail
                activeView={currentView}
                sidebarCollapsed={sidebarCollapsed}
                onNavigate={handleNavigate}
                onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
                attention={{
                    files: anyTestBroken,
                    discovery: discoveryNeedsAttention,
                }}
            />

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
                    onGeneratedTestConsumed={() => setPendingGeneratedTest(undefined)}
                />
            </div>

            <Suspense fallback={<ViewLoader />}>
                {currentView === "quality" && <QualityView />}

                {currentView === "contract" && (
                    <ContractView onGenerateTest={handleGenerateTest} />
                )}
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
