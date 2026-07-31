import { useMemo, useState } from "react";
import { Header } from "../../components/header";
import { OverviewTab } from "./overview-tab";
import { ResultsTab } from "./results-tab";
import {
    canContinueDiscovery,
    canStartDiscovery,
    computeProgressPct,
    deriveActionError,
    deriveQueryError,
    isDiscoveryPaused,
    isDiscoveryRunning,
    shouldShowCompletionBanner,
} from "./runtime-state";
import type { BlockerRow, DiscoveryTab, DiscoveryViewProps, ResultsSubTab } from "./types";
import { useDiscoveryActions } from "./use-discovery-actions";
import { useDiscoveryForm, useDiscoveryRuntime } from "./use-discovery-runtime";
import { useGenerateTestHandoff } from "./use-generate-test-handoff";
import "./discovery.css";

export function DiscoveryScreen({ onGenerateTest }: DiscoveryViewProps) {
    const [activeTab, setActiveTab] = useState<DiscoveryTab>("overview");
    const [resultsSubTab, setResultsSubTab] = useState<ResultsSubTab>("pages");
    const [selectedPageUrl, setSelectedPageUrl] = useState<string | null>(null);
    const [pageOffset, setPageOffset] = useState(0);
    const [dismissedCompletion, setDismissedCompletion] = useState(false);
    const [pendingBlockerId, setPendingBlockerId] = useState<number | null>(null);
    const [pendingHandoffId, setPendingHandoffId] = useState<number | null>(null);

    const runtimeData = useDiscoveryRuntime(selectedPageUrl, pageOffset);
    const { form, setForm, removeExcludePattern, handleExcludeKeyDown } = useDiscoveryForm(
        runtimeData.detectedBaseURL,
    );
    const { toastMessage, handleGenerateTest } = useGenerateTestHandoff(onGenerateTest);

    const actions = useDiscoveryActions({
        form,
        phase: runtimeData.runtime?.phase,
        runtimeHandoffInProgress: Boolean(runtimeData.runtime?.isBrowserHandoffInProgress),
        onClearSelections: () => {
            setSelectedPageUrl(null);
            setPageOffset(0);
        },
        onDismissCompletionReset: () => setDismissedCompletion(false),
        setPendingBlockerId,
        setPendingHandoffId,
    });

    const running = isDiscoveryRunning(runtimeData.runtime?.phase);
    const paused = isDiscoveryPaused(runtimeData.runtime?.phase, runtimeData.latestSession?.status);
    const actionPending = actions.actionPending;
    const handoffActive = actions.handoffActive;
    const canStart = canStartDiscovery({
        url: form.url,
        phase: runtimeData.runtime?.phase,
        sessionStatus: runtimeData.latestSession?.status,
        actionPending,
    });
    const canContinue = canContinueDiscovery({
        phase: runtimeData.runtime?.phase,
        sessionStatus: runtimeData.latestSession?.status,
        actionPending,
    });

    const actionError = useMemo(
        () =>
            deriveActionError({
                startError: actions.startMutation.error?.message,
                continueError: actions.continueMutation.error?.message,
                clearError: actions.clearMutation.error?.message,
                phase: runtimeData.runtime?.phase,
                lastError: runtimeData.runtime?.lastError,
            }),
        [
            actions.startMutation.error,
            actions.continueMutation.error,
            actions.clearMutation.error,
            runtimeData.runtime?.phase,
            runtimeData.runtime?.lastError,
        ],
    );

    const queryError = useMemo(
        () =>
            deriveQueryError({
                flags: {
                    runtime: runtimeData.runtimeQuery.isError,
                    stats: runtimeData.statsQuery.isError,
                    pages: runtimeData.pagesQuery.isError,
                },
                runtimeMessage: runtimeData.runtimeQuery.error?.message,
                statsMessage: runtimeData.statsQuery.error?.message,
                pagesMessage: runtimeData.pagesQuery.error?.message,
            }),
        [
            runtimeData.runtimeQuery.isError,
            runtimeData.runtimeQuery.error,
            runtimeData.statsQuery.isError,
            runtimeData.statsQuery.error,
            runtimeData.pagesQuery.isError,
            runtimeData.pagesQuery.error,
        ],
    );

    const progressPct = computeProgressPct(
        running,
        runtimeData.runtime?.maxPages,
        runtimeData.runtime?.pagesDiscovered,
    );
    const totalResults =
        runtimeData.pagesTotal + runtimeData.verifiedLinks.length + runtimeData.brokenLinks.length;
    const completionReason =
        runtimeData.runtime?.phase === "completed"
            ? (runtimeData.runtime.completionReason ?? undefined)
            : undefined;
    const showCompletion = shouldShowCompletionBanner(completionReason, dismissedCompletion);

    return (
        <div className="discovery-view">
            <Header
                projectName="Discovery"
                failedCount={runtimeData.runtime?.phase === "error" ? 1 : 0}
            />

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

                    {activeTab === "overview" && (
                        <OverviewTab
                            formProps={{
                                form,
                                detectedBaseURL: runtimeData.detectedBaseURL,
                                isPaused: paused,
                                isRunning: running,
                                canStart,
                                canContinue,
                                requiresAuth: Boolean(runtimeData.runtime?.requiresAuth),
                                isActionPending: actionPending,
                                startPending: actions.mutationPending.start,
                                continuePending: actions.mutationPending.continue,
                                pausePending: actions.mutationPending.pause,
                                abortPending: actions.mutationPending.abort,
                                clearPending: actions.mutationPending.clear,
                                dismissErrorPending: actions.mutationPending.dismissError,
                                authAssistFetching: runtimeData.authAssistQuery.isFetching,
                                actionError,
                                queryError,
                                showDismissError: runtimeData.runtime?.phase === "error",
                                onFormChange: setForm,
                                onRemoveExcludePattern: removeExcludePattern,
                                onExcludeKeyDown: handleExcludeKeyDown,
                                onStart: () => {
                                    if (!canStart) return;
                                    actions.handleStart();
                                },
                                onContinue: () => {
                                    if (!canContinue) return;
                                    actions.handleContinue();
                                },
                                onPause: actions.handlePause,
                                onAbort: actions.handleAbort,
                                onClear: actions.handleClear,
                                onDismissError: actions.handleDismissError,
                                onAuthAssist: () => void runtimeData.authAssistQuery.refetch(),
                            }}
                            bannerProps={{
                                isRunning: running,
                                progressPct,
                                pagesDiscovered: runtimeData.runtime?.pagesDiscovered,
                                maxPages: runtimeData.runtime?.maxPages,
                                showCompletion,
                                completionReason,
                                onDismissCompletion: () => setDismissedCompletion(true),
                                showPausedEmptyBlockers:
                                    runtimeData.runtime?.phase === "paused" &&
                                    runtimeData.blockers.length === 0,
                            }}
                            blockers={runtimeData.blockers as BlockerRow[]}
                            blockerPanelProps={{
                                onResolve: actions.resolveBlocker,
                                onHandoff: actions.openHandoff,
                                onCancelHandoff: actions.cancelHandoff,
                                pendingBlockerId,
                                pendingHandoffId,
                                isHandoffActive: handoffActive,
                                cancelHandoffPending: actions.mutationPending.cancelHandoff,
                                isPending: actionPending,
                                authAssistMessage: runtimeData.runtime?.requiresAuth
                                    ? runtimeData.authAssistQuery.data?.message
                                    : null,
                                authAssistCommand: runtimeData.runtime?.requiresAuth
                                    ? runtimeData.authAssistQuery.data?.command
                                    : null,
                            }}
                            summaryProps={{
                                phase: runtimeData.runtime?.phase,
                                pagesCount:
                                    runtimeData.stats?.pagesCount ??
                                    runtimeData.runtime?.pagesDiscovered ??
                                    0,
                                linksCount:
                                    runtimeData.stats?.linksCount ??
                                    runtimeData.runtime?.linksFound ??
                                    0,
                                verifiedLinksCount: runtimeData.stats?.verifiedLinksCount ?? 0,
                                brokenLinksCount: runtimeData.stats?.brokenLinksCount ?? 0,
                                unresolvedBlockersCount:
                                    runtimeData.stats?.unresolvedBlockersCount ?? 0,
                                authBlockersFound: runtimeData.runtime?.authBlockersFound,
                                latestSession: runtimeData.latestSession ?? null,
                            }}
                            timeline={runtimeData.timeline}
                        />
                    )}

                    {activeTab === "results" && (
                        <ResultsTab
                            resultsSubTab={resultsSubTab}
                            onResultsSubTabChange={setResultsSubTab}
                            pagesTotal={runtimeData.pagesTotal}
                            verifiedCount={runtimeData.verifiedCount}
                            brokenCount={runtimeData.brokenCount}
                            pagesProps={{
                                pages: runtimeData.pages,
                                pagesTotal: runtimeData.pagesTotal,
                                pagesHasMore: runtimeData.pagesHasMore,
                                pageOffset,
                                selectedPageUrl,
                                snapshotLoading: runtimeData.pageSnapshotQuery.isLoading,
                                snapshotJson: runtimeData.selectedSnapshot?.snapshotJson,
                                snapshotMeta: runtimeData.selectedSnapshot
                                    ? {
                                          url: runtimeData.selectedSnapshot.url,
                                          depth: runtimeData.selectedSnapshot.depth,
                                          title: runtimeData.selectedSnapshot.title,
                                      }
                                    : null,
                                showGenerateTest: Boolean(onGenerateTest),
                                onSelectPage: setSelectedPageUrl,
                                onCloseSnapshot: () => setSelectedPageUrl(null),
                                onPageOffsetChange: setPageOffset,
                                onGenerateTest: handleGenerateTest,
                            }}
                            verifiedLinks={runtimeData.verifiedLinks}
                            brokenLinks={runtimeData.brokenLinks}
                        />
                    )}
                </div>
            </div>

            {toastMessage && (
                <output className="dv-toast" aria-live="polite">
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
                </output>
            )}
        </div>
    );
}

export default DiscoveryScreen;
