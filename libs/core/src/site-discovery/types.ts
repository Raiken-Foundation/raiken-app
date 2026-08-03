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
    /**
     * JSON-serialised {@link PageForms} — the structured form fields discovery
     * extracted from this page (label/type/selector per input + submit labels).
     * Null when the page has no forms or was recorded before form capture.
     */
    formsJson: string | null;
    parentUrl: string | null;
    navigationAction: string | null;
    depth: number;
    discoveredAt: number;
    lastVisitedAt: number;
    visitCount: number;
    /**
     * True when the crawl that produced this row was carrying a loaded
     * storageState — i.e. the snapshot is of the signed-in application.
     * Describes the content currently stored, so a signed-out re-crawl of the
     * same URL clears it. Cover reads this to know whether it has ever seen
     * anything behind the login, which "an auth-state.json exists on disk"
     * does not tell it.
     */
    capturedAuthenticated?: boolean;
}

/**
 * A single form input discovery observed on a page. Kept lightweight and
 * selector-friendly so test generation can build getByRole/getByLabel/
 * getByPlaceholder locators without re-visiting the page.
 */
export interface DiscoveredFormField {
    /** Best human label (aria-label, <label>, placeholder, or name). */
    label: string;
    /** Input type (e.g. "email", "password", "text") or the tag for select/textarea. */
    type: string;
    placeholder?: string;
    name?: string;
    id?: string;
    testId?: string;
    required?: boolean;
}

/** Structured forms captured for one page. */
export interface PageForms {
    fields: DiscoveredFormField[];
    /** Text/labels of submit-style buttons on the page. */
    submits: string[];
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
 * Discovery blocker categories.
 *
 * Anything the crawler hits that needs a human (or a pre-baked artifact like
 * an auth state file) to clear before crawling can continue. Detectors emit
 * one of these; the dashboard renders category-appropriate resolution UI.
 *
 * - `auth_required`     login wall — clear with `raiken auth` or a state file
 * - `captcha`           bot challenge (Cloudflare, hCaptcha, reCAPTCHA, etc.)
 * - `consent_wall`      cookie/GDPR overlay intercepting clicks
 * - `rate_limited`      429 / "too many requests" page
 * - `geo_blocked`       region-locked
 * - `interstitial`      generic full-screen modal blocking interaction
 * - `error_page`        5xx / app crash that needs manual investigation
 * - `manual`            user-initiated pause ("I want to look around")
 * - `unknown`           detector confidence too low to classify
 */
export type BlockerCategory =
    | "auth_required"
    | "captcha"
    | "consent_wall"
    | "rate_limited"
    | "geo_blocked"
    | "interstitial"
    | "error_page"
    | "manual"
    | "unknown";

/**
 * How aggressively the crawler should react when a blocker fires.
 * - `pause`  stop the whole crawl; wait for the user to resolve
 * - `skip`   record it and move on (e.g. one stale 5xx route on a healthy site)
 * - `log`    record only; don't even mark the URL broken
 */
export type BlockerSeverity = "pause" | "skip" | "log";

/**
 * How a blocker was eventually resolved by the user.
 *
 * - `clear`           "the page is fine now, just retry"
 * - `skip`            "skip just this URL, continue the rest of the crawl"
 * - `ignore_category` "don't pause for this category again this session"
 * - `provide_state`   "here's a Playwright storageState file" (auth flow)
 * - `handoff`         "I drove a real browser; here's the resulting state"
 */
export type BlockerResolution = "clear" | "skip" | "ignore_category" | "provide_state" | "handoff";

/**
 * Generalised blocker record. Replaces the legacy `AuthBlocker`.
 *
 * `evidenceJson` is a free-form JSON blob the detector can use to hand the
 * dashboard whatever it needs (response body excerpt, iframe selector list,
 * matched error string, screenshot path, ...). The dashboard treats it as
 * opaque and just renders a summary.
 */
export interface DiscoveryBlocker {
    id?: number;
    projectPath: string;
    url: string;
    /** Generalised category — see {@link BlockerCategory}. */
    category: BlockerCategory;
    /** What the crawler should do on first sight. */
    severity: BlockerSeverity;
    /**
     * Identifier for the detector that produced this blocker
     * (e.g. `"auth:login_form"`, `"manual_fallback:captcha_iframe"`).
     * Used purely for logging / debugging, not behavior.
     */
    detectorId: string | null;
    /** Legacy alias of evidenceJson, kept so old code still reads. */
    detectedElements: string | null;
    /** Free-form JSON evidence (matched selectors, status, snippets, ...). */
    evidenceJson: string | null;
    /** Optional path to a screenshot taken at detection time. */
    screenshotPath: string | null;
    /** How the user (or auto-resolver) cleared this blocker. */
    resolution: BlockerResolution | null;
    /**
     * Free-form note about how resolution happened — e.g. `"raiken auth"`,
     * `"dashboard handoff"`, `"skipped by user"`.
     */
    resolvedVia: string | null;
    resolvedAt: number | null;
    /** Path to Playwright storageState if `provide_state`/`handoff`. */
    storageStatePath: string | null;
    discoveredAt: number;
}

/**
 * Back-compat alias. External callers (and our own legacy method names)
 * keep referring to `AuthBlocker`; new code should use `DiscoveryBlocker`.
 *
 * The historical `blockerType` field is now derived from `detectorId`
 * (everything after the colon) so `getAuthBlockers` keeps working.
 */
export type AuthBlocker = DiscoveryBlocker & {
    /**
     * Legacy field; prefer `detectorId` + `category` on new code.
     *
     * Optional because `DiscoveryBlocker` rows from non-auth detectors
     * (captcha, manual pause, error_page, ...) are still valid `AuthBlocker`
     * shapes for callers that only consume the generic fields.
     */
    blockerType?: AuthBlockerType;
};

/**
 * Legacy auth-specific blocker type strings, kept for back-compat with
 * external scripts that destructure `blockerType`.
 *
 * `login_redirect` is the strongest pre-DOM signal: a server-side redirect
 * chain that lands on a login-shaped URL. Detected from Playwright's
 * request chain rather than the rendered DOM, so it fires even when the
 * login page hasn't hydrated yet, has no password input (magic-link
 * flows), or was withheld by anti-bot heuristics.
 */
export type AuthBlockerType =
    | "url_pattern"
    | "login_form"
    | "oauth_button"
    | "error_message"
    | "http_status"
    | "login_redirect";

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
    /**
     * JSON-serialised array of URLs the user explicitly told us to skip after
     * a blocker fired. Survives a pause/resume cycle so we don't re-block on
     * the same URL.
     */
    skippedUrlsJson?: string | null;
    /**
     * JSON-serialised array of {@link BlockerCategory} values the user told
     * us to ignore for the rest of this session. Detectors may still inspect
     * the page, but matching categories are skipped so later detectors and
     * normal page processing can continue.
     */
    ignoredCategoriesJson?: string | null;
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
    /**
     * When `continueSession` is true, throw away Crawlee's persistent
     * RequestQueue (handled-URL log + pending entries) and re-seed it with
     * `startUrl`. Use after a fresh auth handoff, captcha solve, or any
     * resolution that materially changes what the crawler can see — the
     * post-login DOM at `/` typically exposes a totally different link
     * graph than the unauthenticated one, and Crawlee's queue would
     * otherwise short-circuit the re-visit (URL already marked handled).
     * Discovered pages/links in the database are preserved.
     */
    purgeQueueOnResume?: boolean;
    /**
     * Hard wall-clock cap on a single discovery run. When reached, the
     * crawler pauses gracefully (preserving queue state for resume).
     * Defaults to 30 minutes. Set to 0 to disable.
     */
    maxRunTimeMs?: number;
    /**
     * Keep query strings when deduping/normalizing URLs. By default the crawler
     * collapses `/item?id=1` and `/item?id=2` into a single page (`/item`),
     * which is right for tracking params but wrong for apps that render distinct
     * content per query value. Enable to treat query-distinct URLs as distinct
     * pages. Fragments and trailing slashes are still normalized.
     */
    preserveQueryParams?: boolean;
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
 * A single page discovery actually visited — the authoritative route catalog
 * the test generator uses instead of guessing URLs.
 */
export interface DiscoveredRoute {
    url: string;
    title: string | null;
    depth: number;
    /** Structured form controls observed on this page, when any. */
    forms?: PageForms;
}

/**
 * Aggregated site knowledge for agent context
 */
export interface SiteKnowledge {
    pagesDiscovered: number;
    /** Real routes discovery visited (url + title). The generator MUST use these. */
    routes: DiscoveredRoute[];
    verifiedPaths: NavigationPath[];
    authRequiredRoutes: string[];
    workingSelectors: SelectorHint[];
    brokenLinks: string[];
}

/**
 * Discovery event types.
 *
 * `blocker_detected` is the new generalised event. `auth_blocked` is still
 * emitted alongside it for one release so external listeners (CLI scripts,
 * the dashboard runtime listener) keep working unchanged.
 */
export type DiscoveryEventType =
    | "page_discovered"
    | "link_found"
    | "blocker_detected"
    | "auth_blocked"
    | "session_paused"
    | "session_resumed"
    | "session_completed"
    | "snapshot_failed"
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
    | { blocker: DiscoveryBlocker }
    | { stats: DiscoveryStats; reason?: "aborted" | "wall_clock_cap" }
    | { url: string; message: string; code?: string }
    | { error: Error };
