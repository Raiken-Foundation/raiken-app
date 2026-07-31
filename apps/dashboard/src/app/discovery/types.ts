export type DiscoveryTab = "overview" | "results";
export type ResultsSubTab = "pages" | "verified" | "broken";

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

export type BlockerResolution = "clear" | "skip" | "ignore_category" | "provide_state";

export interface BlockerRow {
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

export interface DiscoveryFormState {
    url: string;
    maxPages: string;
    maxDepth: string;
    timeout: string;
    skipAuth: boolean;
    excludePatterns: string[];
}

export interface DiscoveryViewProps {
    onGenerateTest?: (pageUrl: string) => void;
}

export interface DiscoveredPageRow {
    url: string;
    depth: number;
    title?: string | null;
}

export interface VerifiedLinkRow {
    fromUrl: string;
    toUrl: string;
    selector: string | null;
    linkText?: string | null;
}

export interface BrokenLinkRow {
    fromUrl: string;
    toUrl: string;
    errorMessage?: string | null;
}

export interface TimelineEventRow {
    id: number | string;
    type: string;
    message: string;
    timestamp: string;
}
