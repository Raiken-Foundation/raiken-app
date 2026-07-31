import {
    POLL_DATA_ACTIVE_MS,
    POLL_DATA_IDLE_MS,
    POLL_RUNTIME_ACTIVE_MS,
    POLL_RUNTIME_IDLE_MS,
} from "./constants";

export interface RuntimePhaseSnapshot {
    phase?: string;
    lastError?: string | null;
    maxPages?: number;
    pagesDiscovered?: number;
    completionReason?: string | null;
    requiresAuth?: boolean;
    isBrowserHandoffInProgress?: boolean;
}

export interface SessionStatusSnapshot {
    status?: string;
}

export interface MutationPendingFlags {
    start: boolean;
    continue: boolean;
    clear: boolean;
    pause: boolean;
    abort: boolean;
    dismissError: boolean;
    cancelHandoff: boolean;
    handoff: boolean;
}

export interface QueryErrorFlags {
    runtime: boolean;
    stats: boolean;
    pages: boolean;
}

export function deriveRuntimePollMs(phase: string | undefined): number {
    return phase === "running" ? POLL_RUNTIME_ACTIVE_MS : POLL_RUNTIME_IDLE_MS;
}

export function deriveDataPollMs(phase: string | undefined): number {
    return phase === "running" ? POLL_DATA_ACTIVE_MS : POLL_DATA_IDLE_MS;
}

export function isDiscoveryRunning(phase: string | undefined): boolean {
    return phase === "running";
}

export function isDiscoveryPaused(
    phase: string | undefined,
    sessionStatus: string | undefined,
): boolean {
    return phase === "paused" || sessionStatus === "paused";
}

export function isActionPending(flags: MutationPendingFlags): boolean {
    return (
        flags.start ||
        flags.continue ||
        flags.clear ||
        flags.pause ||
        flags.abort ||
        flags.dismissError ||
        flags.cancelHandoff ||
        flags.handoff
    );
}

/** Single guard for mutations and in-flight server handoff. */
export function isDiscoveryActionPending(
    flags: MutationPendingFlags,
    runtimeHandoffInProgress: boolean,
): boolean {
    return isActionPending(flags) || runtimeHandoffInProgress;
}

export interface RuntimePollQueryState {
    phase?: string;
}

export function resolveRuntimeRefetchInterval(data: RuntimePollQueryState | undefined): number {
    return deriveRuntimePollMs(data?.phase);
}

export function resolveDataRefetchInterval(phase: string | undefined): number {
    return deriveDataPollMs(phase);
}

export function isHandoffActive(
    handoffPending: boolean,
    runtime: RuntimePhaseSnapshot | undefined,
): boolean {
    return handoffPending || Boolean(runtime?.isBrowserHandoffInProgress);
}

export function canStartDiscovery(params: {
    url: string;
    phase: string | undefined;
    sessionStatus: string | undefined;
    actionPending: boolean;
}): boolean {
    return (
        Boolean(params.url.trim()) &&
        !isDiscoveryRunning(params.phase) &&
        !isDiscoveryPaused(params.phase, params.sessionStatus) &&
        !params.actionPending
    );
}

export function canContinueDiscovery(params: {
    phase: string | undefined;
    sessionStatus: string | undefined;
    actionPending: boolean;
}): boolean {
    return isDiscoveryPaused(params.phase, params.sessionStatus) && !params.actionPending;
}

export function computeProgressPct(
    isRunning: boolean,
    maxPages: number | null | undefined,
    pagesDiscovered: number | null | undefined,
): number | null {
    if (!isRunning || !maxPages) return null;
    const discovered = pagesDiscovered ?? 0;
    return Math.min(Math.round((discovered / maxPages) * 100), 100);
}

export function shouldShowCompletionBanner(
    completionReason: string | undefined,
    dismissed: boolean,
): boolean {
    return Boolean(completionReason) && !dismissed;
}

export function deriveActionError(params: {
    startError?: string;
    continueError?: string;
    clearError?: string;
    phase?: string;
    lastError?: string | null;
}): string | null {
    if (params.startError) return params.startError;
    if (params.continueError) return params.continueError;
    if (params.clearError) return params.clearError;
    if (params.phase === "error") return params.lastError ?? "Discovery failed";
    return null;
}

export function deriveQueryError(params: {
    flags: QueryErrorFlags;
    runtimeMessage?: string;
    statsMessage?: string;
    pagesMessage?: string;
}): string | null {
    if (params.flags.runtime && params.runtimeMessage) {
        return `Runtime query failed: ${params.runtimeMessage}`;
    }
    if (params.flags.stats && params.statsMessage) {
        return `Stats query failed: ${params.statsMessage}`;
    }
    if (params.flags.pages && params.pagesMessage) {
        return `Pages query failed: ${params.pagesMessage}`;
    }
    return null;
}

export function formatProvideStateError(message: string): string {
    if (/storage\s*state|auth-state|provide_state/i.test(message)) {
        return message;
    }
    return message;
}

export function buildGenerateTestToast(pageUrl: string): string {
    return `Sending to AI Agent: ${pageUrl}`;
}

export function buildGenerateTestPrompt(pageUrl: string): string {
    return `Generate E2E tests for ${pageUrl}`;
}
