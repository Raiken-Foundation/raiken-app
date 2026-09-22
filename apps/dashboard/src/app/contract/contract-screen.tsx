import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Logo } from "../../components/logo";
import "./contract.css";
import { trpc } from "../../utils/trpc";

const DiscoveryView = lazy(() =>
    import("../discovery-view").then((m) => ({ default: m.DiscoveryView })),
);

type ContractTab = "portfolio" | "acquisition";

/** `#/contract` (portfolio) · `#/contract/acquisition` · legacy `#/discovery`. */
function getContractTabFromHash(): ContractTab {
    const h = window.location.hash;
    if (/^#\/discovery/.test(h)) return "acquisition";
    return h.match(/^#\/contract\/([a-z]+)/)?.[1] === "acquisition" ? "acquisition" : "portfolio";
}

interface ContractScreenProps {
    /** Discovery's "generate test" handoff — passed through to the
     *  acquisition tab. */
    onGenerateTest?: (pageUrl: string) => void;
}

const FACTS_SHOWN = 40;

function timeAgo(ts: number | null | undefined): string {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function Cmd({ flags, args }: { flags: string; args?: string }) {
    return (
        <div className="c-cmd">
            <span className="c-cmd-prompt">$</span>
            <span className="c-cmd-text">
                <span className="c-cmd-bin">raiken</span> <span className="c-cmd-flag">{flags}</span>
                {args ? <span className="c-cmd-arg"> {args}</span> : null}
            </span>
        </div>
    );
}

function ContractOnboarding() {
    return (
        <section className="c-panel c-onboard">
            <div className="c-panel-head">
                <span>behavior contract — getting started</span>
            </div>
            <div className="c-panel-body">
                <p className="c-onboard-text">
                    The contract has two sides: what the app actually does (observed facts) and what
                    the business asked for (requirements). The gap between them is your test plan.
                </p>
                <ol className="c-onboard-steps">
                    <li className="c-onboard-step">
                        <span className="c-onboard-n">1</span>
                        <div className="c-onboard-body">
                            <span className="c-onboard-text">Observe the running app</span>
                            <Cmd flags="contract capture" args="http://localhost:3000" />
                            <p className="c-onboard-hint">
                                Drives the app, records what each route does, mints facts with
                                evidence.
                            </p>
                        </div>
                    </li>
                    <li className="c-onboard-step">
                        <span className="c-onboard-n">2</span>
                        <div className="c-onboard-body">
                            <span className="c-onboard-text">Import the requirements</span>
                            <Cmd flags="contract import --file" args="requirements.md" />
                            <p className="c-onboard-hint">
                                Acceptance criteria from markdown, or straight from a ticket:
                                raiken contract import --ticket PROJ-23.
                            </p>
                        </div>
                    </li>
                    <li className="c-onboard-step">
                        <span className="c-onboard-n">3</span>
                        <div className="c-onboard-body">
                            <span className="c-onboard-text">Check the contract on every change</span>
                            <Cmd flags="contract verify" />
                            <p className="c-onboard-hint">
                                Re-observes the facts touched by your diff; exit code 1 on a
                                violation. Materialize specs any time: raiken contract materialize.
                            </p>
                        </div>
                    </li>
                </ol>
            </div>
        </section>
    );
}

/**
 * The contract portfolio: two-sided coverage (business intent vs observed
 * behavior), facts with confidence, requirements with verdicts — and the
 * actions that act on the delta: verify (re-observe now), explore (chase an
 * uncovered requirement), materialize (emit disposable specs).
 */
export default function ContractScreen({ onGenerateTest }: ContractScreenProps = {}) {
    const view = trpc.contractView.useQuery(undefined, { refetchInterval: 30000 });
    const utils = trpc.useUtils();
    const [tab, setTab] = useState<ContractTab>(getContractTabFromHash);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [expandedFact, setExpandedFact] = useState<string | null>(null);
    const [factFilter, setFactFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "verified" | "violated" | "unverified">(
        "all",
    );
    const [reqTab, setReqTab] = useState<"attention" | "all">("attention");
    const [actionNote, setActionNote] = useState<string | null>(null);

    const reviews = trpc.contractReviews.useQuery(
        { status: "pending" },
        { refetchInterval: 30000 },
    );
    const resolveReview = trpc.contractResolveReview.useMutation({
        onSettled: () => {
            void utils.contractReviews.invalidate();
            void utils.contractView.invalidate();
        },
    });
    const restoreReview = trpc.contractRestoreReview.useMutation({
        onSettled: () => {
            void utils.contractReviews.invalidate();
            void utils.contractView.invalidate();
            void utils.contractEvents.invalidate();
        },
    });
    const [undoable, setUndoable] = useState<{ id: number } | null>(null);

    const factEvents = trpc.contractEvents.useQuery(
        { factKey: expandedFact ?? undefined },
        { enabled: !!expandedFact },
    );
    const recentEvents = trpc.contractEvents.useQuery(undefined, {
        refetchInterval: 60000,
    });

    const verify = trpc.contractVerify.useMutation({
        onSettled: () => void utils.contractView.invalidate(),
    });
    const explore = trpc.contractExplore.useMutation({
        onSettled: () => void utils.contractView.invalidate(),
    });
    const materialize = trpc.contractMaterialize.useMutation();

    useEffect(() => {
        const onHashChange = () => setTab(getContractTabFromHash());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    useEffect(() => {
        if (!verify.data) return;
        const v = verify.data;
        const violated = v.verdicts.filter((x) => x.verdict === "violated").length;
        setActionNote(
            `verify: ${v.verdicts.length - violated} verified · ${violated} violated (${v.scoped}/${v.total} facts)`,
        );
    }, [verify.data]);
    useEffect(() => {
        if (!explore.data) return;
        const cov = explore.data.coverage;
        setActionNote(
            `explore: ${cov.covered}/${cov.total} covered · ${cov.uncovered} still uncovered`,
        );
    }, [explore.data]);
    useEffect(() => {
        if (!materialize.data) return;
        setActionNote(`materialize: ${materialize.data.testCount} spec(s) → ${materialize.data.specPath}`);
    }, [materialize.data]);
    useEffect(() => {
        if (verify.isError) setActionNote(`verify failed: ${String(verify.error?.message ?? verify.error)}`);
        if (explore.isError) setActionNote(`explore failed: ${String(explore.error?.message ?? explore.error)}`);
        if (materialize.isError)
            setActionNote(`materialize failed: ${String(materialize.error?.message ?? materialize.error)}`);
    }, [verify.isError, verify.error, explore.isError, explore.error, materialize.isError, materialize.error]);

    // R2: keyboard decisions on the review queue (Chromatic's A/R).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey) return;
            const pending = reviews.data ?? [];
            if (pending.length === 0) return;
            const k = e.key.toLowerCase();
            if (k === "a") {
                resolveReview.mutate({ reviewId: pending[0].id, accept: true });
                setUndoable({ id: pending[0].id });
                setActionNote(`accepted: ${pending[0].route} — ${pending[0].action} (old fact retired)`);
            } else if (k === "r") {
                resolveReview.mutate({ reviewId: pending[0].id, accept: false });
                setActionNote(`rejected: ${pending[0].route} — stands as a regression`);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [reviews.data, resolveReview]);

    const selectTab = (next: ContractTab) => {
        window.location.hash = next === "acquisition" ? "#/contract/acquisition" : "#/contract";
        setTab(next);
    };

    const statusbar = (
        <header className="c-statusbar">
            <span className="c-status-cell c-status-cell--brand">
                <Logo size={12} bare />
                <span>raiken/contract</span>
            </span>
        </header>
    );

    if (tab === "acquisition") {
        return (
            <div className="c-shell">
                {statusbar}
                <nav className="q-tabs" aria-label="Contract sections">
                    <button
                        type="button"
                        className="q-tab"
                        onClick={() => selectTab("portfolio")}
                    >
                        portfolio
                    </button>
                    <button
                        type="button"
                        className="q-tab is-active"
                        aria-current="page"
                    >
                        acquisition
                    </button>
                </nav>
                <div className="c-acquisition">
                    <Suspense
                        fallback={
                            <div className="c-loading">
                                <span className="c-loading-spin" aria-hidden="true" />
                                <span>Loading discovery…</span>
                            </div>
                        }
                    >
                        <DiscoveryView onGenerateTest={onGenerateTest} />
                    </Suspense>
                </div>
            </div>
        );
    }

    if (view.isLoading) {
        return (
            <div className="c-shell">
                {statusbar}
                <main className="c-main">
                    {[0, 1].map((n) => (
                        <section key={n} className="c-panel">
                            <div className="c-panel-head">
                                <span className="q-skel" style={{ width: "140px", height: "10px" }} />
                            </div>
                            <div className="c-panel-body">
                                {[64, 100, 84, 92, 70].map((w, i) => (
                                    <div
                                        key={i}
                                        className="q-skel"
                                        style={{ width: `${w}%`, height: "12px", marginBottom: "10px" }}
                                    />
                                ))}
                            </div>
                        </section>
                    ))}
                </main>
            </div>
        );
    }
    if (view.isError || !view.data) {
        return (
            <div className="c-shell">
                {statusbar}
                <div className="c-loading">Contract unavailable: {String(view.error ?? "no data")}</div>
            </div>
        );
    }

    const { observed, intent, coverage } = view.data;
    const confidences = observed.map((f) => f.confidence);
    const avgConfidence =
        confidences.length > 0
            ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100)
            : 0;
    const bothEmpty = observed.length === 0 && intent.length === 0;
    const lastChecked = observed.reduce<number | null>(
        (max, f) => (f.lastVerifiedAt && (!max || f.lastVerifiedAt > max) ? f.lastVerifiedAt : max),
        null,
    );
    const busy = verify.isPending || explore.isPending || materialize.isPending;

    const statusCounts = observed.reduce<Record<string, number>>((acc, f) => {
        acc[f.status] = (acc[f.status] ?? 0) + 1;
        return acc;
    }, {});
    const filteredFacts = observed.filter((f) => {
        if (statusFilter !== "all" && f.status !== statusFilter) return false;
        if (!factFilter.trim()) return true;
        const q = factFilter.trim().toLowerCase();
        return (
            f.route.toLowerCase().includes(q) ||
            f.action.toLowerCase().includes(q) ||
            f.expectedObservable.toLowerCase().includes(q)
        );
    });

    return (
        <div className="c-shell">
            <header className="c-statusbar">
                <span className="c-status-cell c-status-cell--brand">
                    <Logo size={12} bare />
                    <span>raiken/contract</span>
                </span>
                <span className="c-status-cell">
                    <span className="c-status-key">facts</span>
                    <span className="c-status-val">{observed.length}</span>
                </span>
                <span className="c-status-cell">
                    <span className="c-status-key">requirements</span>
                    <span className="c-status-val">{intent.length}</span>
                </span>
                <span className="c-status-cell">
                    <span className="c-status-key">avg confidence</span>
                    <span className="c-status-val">{avgConfidence}%</span>
                </span>
                <span className="c-status-cell">
                    <span className="c-status-key">checked</span>
                    <span className="c-status-val">{timeAgo(lastChecked)}</span>
                </span>
                <span className="c-status-spacer" />
                <button
                    type="button"
                    className="q-btn q-btn--sm q-btn--primary"
                    onClick={() => verify.mutate({})}
                    disabled={busy || observed.length === 0}
                    title="Re-observe every fact against the live app"
                >
                    {verify.isPending ? "verifying…" : "▶ verify"}
                </button>
                <button
                    type="button"
                    className="q-btn q-btn--sm"
                    title="Copy the contract status as markdown (standups, PRs)"
                    onClick={() => {
                        const c = coverage;
                        const uncovered = (c?.entries ?? [])
                            .filter((e) => e.verdict !== "covered")
                            .map((e) => `- [${e.verdict}] ${e.intent.requirementText}${e.intent.ticketId ? ` (#${e.intent.ticketId})` : ""}`)
                            .join("\n");
                        const md = [
                            `**raiken contract — ${c?.violated ? "violations" : c?.uncovered ? "gaps" : "passing"}**`,
                            `${c?.covered ?? 0}/${c?.total ?? 0} requirements covered · ${observed.length} facts · avg ${avgConfidence}% confidence · checked ${timeAgo(lastChecked)}`,
                            uncovered ? `\nNeeds attention:\n${uncovered}` : "",
                            (reviews.data ?? []).length > 0
                                ? `\n${(reviews.data ?? []).length} behavior change(s) awaiting review`
                                : "",
                        ].join("\n");
                        void navigator.clipboard.writeText(md).then(
                            () => setActionNote("contract status copied as markdown"),
                            () => setActionNote("clipboard unavailable"),
                        );
                    }}
                >
                    ⧉ copy
                </button>
            </header>

            <nav className="q-tabs" aria-label="Contract sections">
                <button type="button" className="q-tab is-active" aria-current="page">
                    portfolio
                </button>
                <button type="button" className="q-tab" onClick={() => selectTab("acquisition")}>
                    acquisition
                </button>
            </nav>

            {coverage ? (
                <div
                    className={`c-verdict-banner c-verdict-banner--${
                        coverage.violated > 0 ? "fail" : coverage.uncovered > 0 ? "warn" : "pass"
                    }`}
                >
                    <span className="c-verdict-badge">
                        {coverage.violated > 0
                            ? "violations"
                            : coverage.uncovered > 0
                              ? "gaps"
                              : "passing"}
                    </span>
                    <span className="c-verdict-summary">
                        {coverage.violated > 0
                            ? `${coverage.violated} requirement(s) violated — accept the change or fix the app`
                            : coverage.uncovered > 0
                              ? `${coverage.uncovered} requirement(s) not yet observed — explore or capture`
                              : "every requirement is backed by a verified fact"}
                        <span className="c-verdict-sub">
                            {" "}· {coverage.covered}/{coverage.total} covered · checked{" "}
                            {timeAgo(lastChecked)}
                        </span>
                    </span>
                    <span className="c-trend" aria-label="verified vs violated per day, last 7 days">
                        {(() => {
                            const days = Array.from({ length: 7 }, (_, i) => {
                                const d = new Date();
                                d.setHours(0, 0, 0, 0);
                                d.setDate(d.getDate() - (6 - i));
                                return d.getTime();
                            });
                            return days.map((start, i) => {
                                const end = start + 86400000;
                                const evs = (recentEvents.data ?? []).filter(
                                    (e) => e.occurredAt >= start && e.occurredAt < end,
                                );
                                const v = evs.filter((e) => e.eventType === "verified").length;
                                const x = evs.filter((e) => e.eventType === "violated").length;
                                const max = 6;
                                return (
                                    <span
                                        key={`d${i}`}
                                        className="c-trend-day"
                                        title={`${new Date(start).toLocaleDateString(undefined, { weekday: "short" })}: ${v} verified, ${x} violated`}
                                    >
                                        <span className="c-trend-ok" style={{ height: `${Math.min(v, max) * 3 + 2}px` }} />
                                        {x > 0 ? <span className="c-trend-bad" style={{ height: `${Math.min(x, max) * 3 + 2}px` }} /> : null}
                                    </span>
                                );
                            });
                        })()}
                    </span>
                    <span className="c-verdict-spark" aria-label="recent verification history">
                        {(recentEvents.data ?? []).slice(0, 40).reverse().map((e) => (
                            <span
                                key={`b-${e.id ?? e.occurredAt}`}
                                className={`c-evsq c-evsq--${e.eventType}`}
                                title={`${e.eventType} · ${timeAgo(e.occurredAt)}`}
                            />
                        ))}
                    </span>
                </div>
            ) : null}

            {(reviews.data ?? []).length > 0 ? (
                <section className="c-review" aria-label="Pending behavior changes">
                    <div className="c-review-head">
                        <span>behavior changes awaiting review</span>
                        <span className="c-panel-count">{reviews.data?.length}</span>
                    </div>
                    <ul className="c-review-list">
                        {(reviews.data ?? []).map((r) => (
                            <li key={r.id} className="c-review-row">
                                <span className="c-review-body">
                                    <span className="c-fact-route">
                                        {r.route} — {r.action}
                                    </span>
                                    <span className="c-review-expected">
                                        expected: {r.expectedObservable}
                                    </span>
                                    <span className="c-review-observed">{r.observed}</span>
                                </span>
                                <span className="c-review-actions">
                                    <button
                                        type="button"
                                        className="q-btn q-btn--sm q-btn--primary"
                                        disabled={resolveReview.isPending}
                                        title="The change was intentional — retire the old fact"
                                        onClick={() => {
                                        resolveReview.mutate({ reviewId: r.id, accept: true });
                                        setUndoable({ id: r.id });
                                    }}
                                    >
                                        ✓ accept
                                    </button>
                                    <button
                                        type="button"
                                        className="q-btn q-btn--sm q-btn--danger"
                                        disabled={resolveReview.isPending}
                                        title="It's a regression — the violation stands"
                                        onClick={() => resolveReview.mutate({ reviewId: r.id, accept: false })}
                                    >
                                        ✗ regression
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {actionNote ? (
                <div className="c-action-note" role="status">
                    <span>{actionNote}</span>
                    {undoable ? (
                        <button
                            type="button"
                            className="q-btn q-btn--ghost q-btn--sm"
                            disabled={restoreReview.isPending}
                            title="Bring the retired fact back as unverified"
                            onClick={() => {
                                restoreReview.mutate({ reviewId: undoable.id });
                                setUndoable(null);
                                setActionNote("fact restored — it re-verifies on the next cycle");
                            }}
                        >
                            ↩ undo accept
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="q-btn q-btn--ghost q-btn--sm"
                        onClick={() => setActionNote(null)}
                        aria-label="dismiss"
                    >
                        ×
                    </button>
                </div>
            ) : null}

            {bothEmpty ? (
                <main className="c-main">
                    <ContractOnboarding />
                </main>
            ) : (
                <main className="c-main">
                    <section className="c-panel">
                        <div className="c-panel-head">
                            <span>requirement coverage</span>
                            <span className="c-panel-count">
                                {coverage
                                    ? `${coverage.covered}/${coverage.total} covered`
                                    : `${intent.length} imported`}
                            </span>
                        </div>
                        <div className="c-panel-body">
                            {coverage ? (
                                <>
                                    <div className="c-coverage-bar">
                                        <span
                                            className="c-cov c-cov--covered"
                                            style={{ flex: coverage.covered }}
                                        />
                                        <span
                                            className="c-cov c-cov--uncovered"
                                            style={{ flex: coverage.uncovered }}
                                        />
                                        <span
                                            className="c-cov c-cov--violated"
                                            style={{ flex: coverage.violated }}
                                        />
                                    </div>
                                    <p className="c-cov-legend">
                                        <span className="c-cov-dot c-cov-dot--covered" />{" "}
                                        {coverage.covered} covered ·{" "}
                                        <span className="c-cov-dot c-cov-dot--uncovered" />{" "}
                                        {coverage.uncovered} uncovered ·{" "}
                                        <span className="c-cov-dot c-cov-dot--violated" />{" "}
                                        {coverage.violated} violated
                                        {coverage.neverRegressUncovered > 0 ? (
                                            <span className="c-never">
                                                {" "}
                                                ⚠ {coverage.neverRegressUncovered} never-regress
                                                uncovered
                                            </span>
                                        ) : null}
                                    </p>
                                    <div className="c-triage" role="tablist" aria-label="Requirement triage">
                                        {(["attention", "all"] as const).map((t) => {
                                            const n =
                                                t === "all"
                                                    ? coverage.entries.length
                                                    : coverage.entries.filter((e) => e.verdict !== "covered").length;
                                            return (
                                                <button
                                                    key={t}
                                                    type="button"
                                                    role="tab"
                                                    aria-selected={reqTab === t}
                                                    className={`c-triage-tab ${reqTab === t ? "is-active" : ""}`}
                                                    onClick={() => setReqTab(t)}
                                                >
                                                    {t === "attention" ? "needs attention" : "all"}
                                                    <span className="c-triage-n">{n}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <ul className="c-list">
                                        {(reqTab === "attention"
                                            ? coverage.entries.filter((e) => e.verdict !== "covered")
                                            : coverage.entries
                                        ).map((entry) => {
                                            const isOpen = expandedKey === entry.intent.requirementKey;
                                            return (
                                                <li
                                                    key={entry.intent.requirementKey}
                                                    className={`c-verdict c-verdict--${entry.verdict} ${isOpen ? "c-verdict--open" : ""}`}
                                                >
                                                    <button
                                                        type="button"
                                                        className="c-verdict-row"
                                                        onClick={() =>
                                                            setExpandedKey(isOpen ? null : entry.intent.requirementKey)
                                                        }
                                                        aria-expanded={isOpen}
                                                    >
                                                        <span className="c-mark">
                                                            {entry.verdict === "covered"
                                                                ? "✓"
                                                                : entry.verdict === "violated"
                                                                  ? "✗"
                                                                  : "○"}
                                                        </span>
                                                        <span className="c-req-main">
                                                            <span className="c-text">
                                                                {entry.intent.requirementText}
                                                                {entry.intent.ticketId
                                                                    ? ` [#${entry.intent.ticketId}]`
                                                                    : ""}
                                                                {entry.intent.neverRegress ? " 🔒" : ""}
                                                            </span>
                                                            {entry.matches[0] ? (
                                                                <span className="c-match">
                                                                    observed as{" "}
                                                                    {entry.matches[0].fact.action} ·{" "}
                                                                    {Math.round(
                                                                        entry.matches[0].score * 100,
                                                                    )}
                                                                    % match
                                                                </span>
                                                            ) : null}
                                                        </span>
                                                    </button>
                                                    {entry.verdict === "uncovered" ? (
                                                        <div className="c-req-actions">
                                                            <button
                                                                type="button"
                                                                className="q-btn q-btn--sm"
                                                                disabled={busy}
                                                                title="Send the agent to observe this requirement"
                                                                onClick={() => explore.mutate()}
                                                            >
                                                                {explore.isPending ? "exploring…" : "✦ explore"}
                                                            </button>
                                                        </div>
                                                    ) : null}
                                                    {isOpen ? (
                                                        <div className="c-req-detail">
                                                            <dl className="c-req-meta">
                                                                <div>
                                                                    <dt>key</dt>
                                                                    <dd>{entry.intent.requirementKey}</dd>
                                                                </div>
                                                                {entry.intent.ticketId ? (
                                                                    <div>
                                                                        <dt>ticket</dt>
                                                                        <dd>#{entry.intent.ticketId}</dd>
                                                                    </div>
                                                                ) : null}
                                                                <div>
                                                                    <dt>verdict</dt>
                                                                    <dd>{entry.verdict}</dd>
                                                                </div>
                                                            </dl>
                                                            {entry.matches.length === 0 ? (
                                                                <p className="c-req-nomatch">
                                                                    No observed fact matches this
                                                                    requirement yet — explore it, or verify
                                                                    the app is running and re-capture.
                                                                </p>
                                                            ) : (
                                                                entry.matches.slice(0, 3).map((m) => (
                                                                    <div
                                                                        key={m.fact.factKey}
                                                                        className="c-req-match"
                                                                    >
                                                                        <span className="c-fact-route">
                                                                            {m.fact.route} · matched at{" "}
                                                                            {Math.round(m.score * 100)}%
                                                                        </span>
                                                                        <span className="c-fact-action">
                                                                            {m.fact.action} →{" "}
                                                                            {m.fact.expectedObservable}
                                                                        </span>
                                                                        {m.fact.evidence?.snapshotExcerpt ? (
                                                                            <span className="c-evidence">
                                                                                “{m.fact.evidence.snapshotExcerpt.slice(0, 140)}
                                                                                {m.fact.evidence.snapshotExcerpt.length > 140 ? "…" : ""}”
                                                                            </span>
                                                                        ) : null}
                                                                        <span className="c-fact-meta">
                                                                            {m.fact.status} · {Math.round(m.fact.confidence * 100)}% ·{" "}
                                                                            {m.fact.verifiedCount}✓/{m.fact.violatedCount}✗ · checked{" "}
                                                                            {timeAgo(m.fact.lastVerifiedAt)}
                                                                        </span>
                                                                    </div>
                                                                ))
                                                            )}
                                                        </div>
                                                    ) : null}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </>
                            ) : (
                                <div className="c-empty">
                                    <p className="c-empty-title">No requirements imported yet</p>
                                    <p>
                                        Import acceptance criteria from a file or a ticket, and
                                        coverage becomes the delta between them and the observed
                                        facts.
                                    </p>
                                    <Cmd flags="contract import --file" args="requirements.md" />
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="c-panel">
                        <div className="c-panel-head">
                            <span>observed facts</span>
                            <span className="c-panel-count">{observed.length} total</span>
                        </div>
                        <div className="c-panel-body">
                            <div className="c-fact-toolbar">
                                <div className="c-chips" role="group" aria-label="Filter facts by status">
                                    {(["all", "verified", "violated", "unverified"] as const).map((s) => (
                                        <button
                                            key={s}
                                            type="button"
                                            className={`c-chip ${statusFilter === s ? "is-active" : ""}`}
                                            onClick={() => setStatusFilter(s)}
                                        >
                                            {s === "all" ? observed.length : (statusCounts[s] ?? 0)} {s}
                                        </button>
                                    ))}
                                </div>
                                <input
                                    className="c-filter"
                                    type="search"
                                    placeholder="filter by route, action, observable…"
                                    value={factFilter}
                                    onChange={(e) => setFactFilter(e.target.value)}
                                    aria-label="Filter facts"
                                />
                                <button
                                    type="button"
                                    className="q-btn q-btn--sm"
                                    disabled={busy || observed.length === 0}
                                    title="Emit disposable Playwright specs from verified facts"
                                    onClick={() => materialize.mutate({})}
                                >
                                    {materialize.isPending ? "materializing…" : "⇩ materialize"}
                                </button>
                            </div>
                            <ul className="c-list">
                                {filteredFacts
                                    .slice()
                                    .sort((a, b) => {
                                        const rank = (f: typeof a) =>
                                            f.status === "violated" ? 0 : f.status === "unverified" ? 1 : 2;
                                        return rank(a) - rank(b);
                                    })
                                    .slice(0, FACTS_SHOWN)
                                    .map((fact) => {
                                    const isOpen = expandedFact === fact.factKey;
                                    return (
                                    <li
                                        key={fact.factKey}
                                        className={`c-fact c-fact--${fact.status} ${isOpen ? "c-fact--open" : ""}`}
                                    >
                                        <button
                                            type="button"
                                            className="c-fact-row"
                                            onClick={() => setExpandedFact(isOpen ? null : fact.factKey)}
                                            aria-expanded={isOpen}
                                            title={`${fact.status} · ${fact.verifiedCount} verified, ${fact.violatedCount} violated · confidence from verification history`}
                                        >
                                            <span className="c-dot" aria-hidden="true" />
                                            <span className="c-conf">
                                                {Math.round(fact.confidence * 100)}%
                                            </span>
                                            <span className="c-fact-body">
                                                <span className="c-fact-line">
                                                    <span className="c-fact-action">{fact.action}</span>
                                                    <span className="c-fact-arrow"> → </span>
                                                    <span className="c-fact-obs">
                                                        {fact.expectedObservable}
                                                    </span>
                                                </span>
                                                <span className="c-fact-meta">
                                                    {fact.route}
                                                    {fact.precondition ? ` · ${fact.precondition}` : ""}
                                                    {" · "}
                                                    {fact.verifiedCount}✓/{fact.violatedCount}✗ · checked{" "}
                                                    {timeAgo(fact.lastVerifiedAt)}
                                                </span>
                                            </span>
                                        </button>
                                        {isOpen ? (
                                            <div className="c-ledger">
                                                <span className="c-ledger-title">
                                                    evidence ledger · {fact.factKey.slice(0, 12)}
                                                </span>
                                                {fact.evidence?.observedUrl ? (
                                                    <span className="c-evidence">
                                                        observed at {fact.evidence.observedUrl}
                                                    </span>
                                                ) : null}
                                                {(factEvents.data ?? []).length > 0 ? (
                                                    <span
                                                        className="c-strip-events"
                                                        aria-label="verification history"
                                                    >
                                                        {(factEvents.data ?? [])
                                                            .slice(0, 12)
                                                            .reverse()
                                                            .map((e) => (
                                                                <span
                                                                    key={`sq-${e.id ?? e.occurredAt}`}
                                                                    className={`c-evsq c-evsq--${e.eventType}`}
                                                                    title={`${e.eventType} · ${timeAgo(e.occurredAt)}`}
                                                                />
                                                            ))}
                                                    </span>
                                                ) : null}
                                                {(factEvents.data ?? []).length === 0 ? (
                                                    <span className="c-evidence">
                                                        no events recorded yet — verify to start the ledger
                                                    </span>
                                                ) : (
                                                    (factEvents.data ?? []).slice(0, 12).map((e) => (
                                                        <span key={e.id ?? e.occurredAt} className="c-event">
                                                            <span className="c-event-when">
                                                                {timeAgo(e.occurredAt)}
                                                            </span>
                                                            <span
                                                                className={`c-event-type c-event-type--${e.eventType}`}
                                                            >
                                                                {e.eventType}
                                                            </span>
                                                            <span className="c-event-detail">
                                                                {e.detail ?? ""}
                                                            </span>
                                                        </span>
                                                    ))
                                                )}
                                            </div>
                                        ) : null}
                                    </li>
                                    );
                                })}
                            </ul>
                            {filteredFacts.length > FACTS_SHOWN ? (
                                <p className="c-more">
                                    + {filteredFacts.length - FACTS_SHOWN} more —{" "}
                                    <span className="c-cmd-flag">raiken contract show</span>
                                </p>
                            ) : null}
                            {observed.length === 0 ? (
                                <div className="c-empty">
                                    <p className="c-empty-title">No observed facts yet</p>
                                    <p>
                                        Capture the running app to mint facts with evidence, or
                                        re-check what discovery already recorded.
                                    </p>
                                    <Cmd flags="contract capture" args="http://localhost:3000" />
                                    <Cmd flags="contract mint" />
                                </div>
                            ) : filteredFacts.length === 0 ? (
                                <p className="c-empty">No facts match this filter.</p>
                            ) : null}
                        </div>
                    </section>
                </main>
            )}
        </div>
    );
}
