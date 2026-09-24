import { useMemo } from "react";
import { parseEvidence } from "../helpers";
import type { BlockerCategory, BlockerResolution, BlockerRow } from "../types";

export const CATEGORY_LABELS: Record<BlockerCategory, string> = {
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

export interface BlockerPanelProps {
    blockers: BlockerRow[];
    onResolve: (
        blockerId: number,
        category: BlockerCategory,
        resolution: BlockerResolution,
    ) => void;
    onHandoff: (blockerId: number, category: BlockerCategory) => void;
    onCancelHandoff: () => void;
    pendingBlockerId: number | null;
    pendingHandoffId: number | null;
    isHandoffActive: boolean;
    cancelHandoffPending: boolean;
    isPending: boolean;
    authAssistMessage?: string | null;
    authAssistCommand?: string | null;
}

export function BlockerPanel({
    blockers,
    onResolve,
    onHandoff,
    onCancelHandoff,
    pendingBlockerId,
    pendingHandoffId,
    isHandoffActive,
    cancelHandoffPending,
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
            {isHandoffActive && (
                <output className="bp-handoff-active">
                    <span>Browser handoff in progress — complete sign-in or cancel.</span>
                    <button
                        type="button"
                        className="btn secondary sm"
                        onClick={onCancelHandoff}
                        disabled={cancelHandoffPending}
                    >
                        {cancelHandoffPending ? "Cancelling…" : "Cancel handoff"}
                    </button>
                </output>
            )}
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
                        onCancelHandoff={onCancelHandoff}
                        cancelHandoffPending={cancelHandoffPending}
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
    onCancelHandoff: BlockerPanelProps["onCancelHandoff"];
    isResolving: boolean;
    isHandoff: boolean;
    cancelHandoffPending: boolean;
    anyPending: boolean;
}

function BlockerCard({
    blocker,
    onResolve,
    onHandoff,
    onCancelHandoff,
    isResolving,
    isHandoff,
    cancelHandoffPending,
    anyPending,
}: BlockerCardProps) {
    const id = blocker.id;
    const category = blocker.category;
    const evidence = useMemo(() => parseEvidence(blocker.evidenceJson), [blocker.evidenceJson]);
    const isManual = category === "manual";
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
                <section aria-label="Detector evidence">
                    <pre className="bp-evidence">{evidence}</pre>
                </section>
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
                    <>
                        <button
                            type="button"
                            className="btn primary sm"
                            onClick={() => id != null && onHandoff(id, category)}
                            disabled={id == null || anyPending || isHandoff}
                            title="Open this URL in a real Chromium window. When you finish, we'll snapshot the cookies/localStorage and resume the crawl from the start URL."
                        >
                            {isHandoff ? "Browser open…" : handoffLabel}
                        </button>
                        {isHandoff && (
                            <button
                                type="button"
                                className="btn secondary sm"
                                onClick={onCancelHandoff}
                                disabled={cancelHandoffPending}
                            >
                                {cancelHandoffPending ? "Cancelling…" : "Cancel"}
                            </button>
                        )}
                    </>
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
