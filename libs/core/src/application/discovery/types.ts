import type {
    DiscoveryPhase,
    DiscoveryRuntimeEvent,
    DiscoveryRuntimeState,
} from "../../site-discovery/coordinator";
import type { SiteDiscoveryOverrides } from "../../site-discovery/discovery-config";
import type { DiscoveryAuthAssist, SiteKnowledgeStats } from "../../site-discovery/query-service";

export type { DiscoveryPhase, DiscoveryRuntimeEvent, DiscoveryRuntimeState };

export interface StartDiscoveryJobOptions {
    startUrl: string;
    maxPages?: number;
    maxDepth?: number;
    timeout?: number;
    skipAuth?: boolean;
    excludePatterns?: string[];
    continueSession?: boolean;
    purgeQueueOnResume?: boolean;
}

export type DiscoveryResolution = "clear" | "skip" | "ignore_category" | "provide_state";

export interface ContinueDiscoveryInput {
    skipAuth?: boolean;
    resolution?: DiscoveryResolution;
    blockerId?: number;
    category?:
        | "auth_required"
        | "captcha"
        | "consent_wall"
        | "rate_limited"
        | "geo_blocked"
        | "interstitial"
        | "error_page"
        | "manual"
        | "unknown";
    storageStatePath?: string;
}

export interface RequestBrowserHandoffInput {
    url?: string;
    blockerId?: number;
    category?: ContinueDiscoveryInput["category"];
    timeoutMs?: number;
}

export type DiscoveryUxCallbacks = {
    onPageDiscovered?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
    onAuthBlocked?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
    onBlockerDetected?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
    onSessionPaused?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
    onSessionCompleted?: (
        stats: import("../../site-discovery/types").DiscoveryStats | null,
    ) => void;
    onError?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
    onWarning?: (event: import("../../site-discovery/types").DiscoveryEvent) => void;
};

export type BackgroundDiscoverState =
    | { status: "idle" }
    | {
          status: "running" | "paused" | "completed" | "failed";
          startUrl: string;
          pages: number;
          links: number;
          maxPages: number;
          currentUrl?: string;
          error?: string;
          startedAt: number;
      };

export interface RunForegroundInput {
    startUrl: string;
    overrides?: SiteDiscoveryOverrides;
    preferSessionLimits?: boolean;
    session?: { maxPages?: number | null; maxDepth?: number | null } | null;
    resolveStorageState?: boolean;
    storageStatePath?: string | null;
    purgeQueueOnResume?: boolean;
    resolvePendingAuthWithState?: boolean;
}

export type DiscoveryExecutionKind = "detached" | "blocking" | "background";

export interface DiscoveryLaunchInput {
    startUrl: string;
    overrides?: SiteDiscoveryOverrides;
    preferSessionLimits?: boolean;
    session?: { maxPages?: number | null; maxDepth?: number | null } | null;
    resolveStorageState?: boolean;
    storageStatePath?: string | null;
    purgeQueueOnResume?: boolean;
}

export interface DiscoveryLaunchResult {
    promise: Promise<void>;
    background?: {
        state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
        done: Promise<void>;
    };
}

export interface DiscoveryCommandResult {
    success: boolean;
    message: string;
    runtime: DiscoveryRuntimeState;
}

export interface HydratedDiscoveryRuntime extends DiscoveryRuntimeState {
    isRunningInProcess: boolean;
    isBrowserHandoffInProgress: boolean;
}

export interface RequestBrowserHandoffResult extends DiscoveryCommandResult {
    storageStatePath?: string;
    blockersResolved?: number;
    reason?: string;
    blockerResolutionWarning?: string;
    errorMessage?: string;
}

export type CancelBrowserHandoffResult = DiscoveryCommandResult;

export const EMPTY_STATS: SiteKnowledgeStats = {
    pagesCount: 0,
    authenticatedPagesCount: 0,
    linksCount: 0,
    verifiedLinksCount: 0,
    brokenLinksCount: 0,
    authBlockersCount: 0,
    unresolvedBlockersCount: 0,
};

export const DEFAULT_AUTH_ASSIST: DiscoveryAuthAssist = {
    hasUnresolvedBlockers: false,
    unresolvedCount: 0,
    suggestedUrl: null,
    command: "raiken auth --url <login-url>",
    message: "Unable to inspect auth blockers right now.",
};
