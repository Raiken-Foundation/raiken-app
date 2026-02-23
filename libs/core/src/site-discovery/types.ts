/**
 * Site Discovery Types
 *
 * Type definitions for autonomous DOM traversal and site discovery.
 */


/**
 * Discovered page information
 */
export interface DiscoveredPage {
    id?: number;
    projectPath: string;
    url: string;
    normalizedUrl: string;
    title: string | null;
    snapshotJson: string | null;
    parentUrl: string | null;
    navigationAction: string | null;
    depth: number;
    discoveredAt: number;
    lastVisitedAt: number;
    visitCount: number;
}

/**
 * Link between pages
 */
export interface DiscoveredLink {
    id?: number;
    projectPath: string;
    fromUrl: string;
    toUrl: string;
    selector: string;
    linkText: string | null;
    elementRole: string | null;
    status: LinkStatus;
    errorMessage: string | null;
    discoveredAt: number;
    verifiedAt: number | null;
}

/**
 * Link status types
 */
export type LinkStatus = "pending" | "verified" | "broken" | "auth_required";

/**
 * Authentication blocker information
 */
export interface AuthBlocker {
    id?: number;
    projectPath: string;
    url: string;
    blockerType: AuthBlockerType;
    detectedElements: string;
    resolvedAt: number | null;
    storageStatePath: string | null;
    discoveredAt: number;
}

/**
 * Types of authentication blockers
 */
export type AuthBlockerType =
    | "url_pattern"
    | "login_form"
    | "oauth_button"
    | "error_message"
    | "http_status";

/**
 * Discovery session information
 */
export interface DiscoverySession {
    id?: number;
    projectPath: string;
    startUrl: string;
    status: SessionStatus;
    pagesDiscovered: number;
    linksFound: number;
    startedAt: number;
    completedAt: number | null;
    blockedAtUrl: string | null;
    queueJson: string | null;
    maxPages?: number | null;
    maxDepth?: number | null;
}

/**
 * Session status types
 */
export type SessionStatus = "running" | "paused" | "completed" | "failed";

/**
 * Discovery configuration options
 */
export interface DiscoveryOptions {
    startUrl: string;
    projectPath: string;
    maxPages?: number;
    maxDepth?: number;
    maxConcurrency?: number;
    timeout?: number;
    excludePatterns?: string[];
    pauseOnAuth?: boolean;
    storageStatePath?: string | null;
    continueSession?: boolean;
}

/**
 * Discovery statistics
 */
export interface DiscoveryStats {
    pagesDiscovered: number;
    linksFound: number;
    authBlockersFound: number;
    currentDepth: number;
    currentUrl: string | null;
    status: SessionStatus;
    startedAt: number;
    elapsedMs: number;
}

/**
 * Navigation path between pages
 */
export interface NavigationPath {
    fromUrl: string;
    toUrl: string;
    selector: string;
    linkText: string | null;
    verified: boolean;
}

/**
 * Selector hint for test generation
 */
export interface SelectorHint {
    selector: string;
    url: string;
    elementRole: string | null;
    usageCount: number;
}

/**
 * Aggregated site knowledge for agent context
 */
export interface SiteKnowledge {
    pagesDiscovered: number;
    verifiedPaths: NavigationPath[];
    authRequiredRoutes: string[];
    workingSelectors: SelectorHint[];
    brokenLinks: string[];
}

/**
 * Discovery event types
 */
export type DiscoveryEventType =
    | "page_discovered"
    | "link_found"
    | "auth_blocked"
    | "session_paused"
    | "session_resumed"
    | "session_completed"
    | "error";

/**
 * Discovery event data
 */
export interface DiscoveryEvent {
    type: DiscoveryEventType;
    data: DiscoveryEventData;
    timestamp: number;
}

/**
 * Event data payloads
 */
export type DiscoveryEventData =
    | { page: DiscoveredPage }
    | { link: DiscoveredLink }
    | { blocker: AuthBlocker }
    | { stats: DiscoveryStats }
    | { error: Error };

/**
 * Auth detector result
 */
export interface AuthDetectorResult {
    detected: boolean;
    blocker: AuthBlocker | null;
}

