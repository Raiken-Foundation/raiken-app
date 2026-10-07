import type { BoardCall, BoardRow } from "@raiken/shared";
import { useState } from "react";
import { trpc } from "../../utils/trpc";
import {
    type BoardGroup,
    explainCall,
    groupRows,
    statusGlyph,
    statusLabel,
    summarize,
    timeAgo,
} from "./helpers";
import "./board.css";

/**
 * The board — the dashboard's front door and the Reader's only screen.
 *
 * Content rules (product plan, Phase 2):
 * - three statuses in words, never scores or percentages
 * - requirement text verbatim; no facts/mint/observables vocabulary
 * - every broken row cites evidence, a timestamp, and can alert the team
 * - the empty state offers the import action itself, not a CLI command
 */
export function BoardScreen() {
    const utils = trpc.useUtils();
    const board = trpc.contractBoard.useQuery(undefined, { refetchOnWindowFocus: false });
    const project = trpc.getProjectInfo.useQuery(undefined, {
        refetchOnWindowFocus: false,
        staleTime: 60_000,
    });
    const importMutation = trpc.contractImport.useMutation({
        onSettled: () => void utils.contractBoard.invalidate(),
    });

    // The Reader's page must say whose status this is — a bare "Status" is
    // ambiguous the moment a team has more than one app.
    const projectName = (() => {
        const p = project.data?.path;
        if (!p) return null;
        const parts = p.split("/").filter(Boolean);
        return parts[parts.length - 1] ?? p;
    })();

    if (board.isLoading) {
        return (
            <main className="board" aria-busy="true">
                <h1 className="board-h1">Status</h1>
                <p className="board-loading">Reading the contract…</p>
            </main>
        );
    }

    if (board.isError || !board.data) {
        return (
            <main className="board">
                <h1 className="board-h1">Status</h1>
                <p className="board-error" role="alert">
                    The contract could not be read: {String(board.error?.message ?? board.error)}
                </p>
                <button type="button" className="board-retry" onClick={() => void board.refetch()}>
                    Try again
                </button>
            </main>
        );
    }

    const data = board.data;
    const groups = groupRows(data.rows);
    const brokenCount = data.counts.broken;
    // Rows with an open question are linked to their card above, so the same
    // promise does not read as an unexplained duplicate.
    const callFactKeys = new Set((data.needsYourCall ?? []).map((c) => c.factKey));
    const lastChecked = data.rows.reduce<number | null>(
        (latest, row) =>
            row.sinceWhen && (!latest || row.sinceWhen > latest) ? row.sinceWhen : latest,
        null,
    );

    return (
        <main className="board">
            <header className="board-head">
                <div className="board-head-titles">
                    <h1 className="board-h1">Status</h1>
                    <p className="board-project">
                        {projectName ?? "This project"}
                        {lastChecked ? ` · checked ${timeAgo(lastChecked)}` : ""}
                    </p>
                </div>
                {/* A count of nothing is noise on the first-run page — the
                    empty state below explains the next step instead. */}
                {data.rows.length > 0 ? (
                    <p className="board-summary" aria-live="polite">
                        {summarize(data.counts)}
                    </p>
                ) : null}
            </header>

            {data.watch ? (
                <p className="board-watch">
                    watching · last check {timeAgo(data.watch.lastCheckAt)} ·{" "}
                    {data.watch.violated > 0 ? `${data.watch.violated} broken` : "none broken"}
                </p>
            ) : null}

            {/* The one decision that belongs to the Reader: "the app changed —
                was that on purpose?" Answerable with no raiken vocabulary. */}
            {data.needsYourCall && data.needsYourCall.length > 0 ? (
                <section className="board-calls" aria-labelledby="board-calls-title">
                    <h2 id="board-calls-title" className="board-calls-title">
                        Needs your call
                        <span className="board-calls-count">{data.needsYourCall.length}</span>
                    </h2>
                    <ul className="board-call-list">
                        {data.needsYourCall.map((call) => (
                            <BoardCallCard key={call.reviewId} call={call} />
                        ))}
                    </ul>
                </section>
            ) : null}

            {data.rows.length === 0 ? (
                <BoardEmptyState
                    onImport={(input) => importMutation.mutate(input)}
                    pending={importMutation.isPending}
                    error={importMutation.isError ? importMutation.error.message : null}
                    result={
                        importMutation.isSuccess
                            ? {
                                  imported: importMutation.data.imported,
                                  skipped: importMutation.data.skipped,
                              }
                            : null
                    }
                />
            ) : (
                <div className="board-groups">
                    {groups.map((group) => (
                        <BoardGroupSection
                            key={group.key}
                            group={group}
                            highlight={brokenCount > 0}
                            callFactKeys={callFactKeys}
                        />
                    ))}
                </div>
            )}
        </main>
    );
}

function BoardCallCard({ call }: { call: BoardCall }) {
    const utils = trpc.useUtils();
    const resolve = trpc.contractResolveReview.useMutation({
        onSettled: () => {
            void utils.contractBoard.invalidate();
            void utils.contractView.invalidate();
            void utils.contractReviews.invalidate();
        },
    });
    const plain = explainCall(call);

    return (
        <li className="board-call">
            <p className="board-call-title">{plain.title}</p>
            <p className="board-call-change">
                {plain.before} <span className="board-call-now">{plain.now}</span>
            </p>
            <div className="board-call-actions">
                <span className="board-call-question">Was that change intentional?</span>
                <button
                    type="button"
                    className="board-call-btn is-yes"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ reviewId: call.reviewId, accept: true })}
                >
                    Yes — that's correct now
                </button>
                <button
                    type="button"
                    className="board-call-btn is-no"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ reviewId: call.reviewId, accept: false })}
                >
                    No — that's a bug
                </button>
            </div>
            {resolve.isError ? (
                <output className="board-call-error">
                    Could not save that: {resolve.error.message}
                </output>
            ) : null}
        </li>
    );
}

function BoardGroupSection({
    group,
    highlight,
    callFactKeys,
}: {
    group: BoardGroup;
    highlight: boolean;
    callFactKeys: Set<string>;
}) {
    const hasBroken = group.rows.some((r) => r.status === "broken");
    return (
        <section className={`board-group ${hasBroken && highlight ? "has-broken" : ""}`}>
            <h2 className="board-group-title">
                {group.ticketUrl ? (
                    <a href={group.ticketUrl} target="_blank" rel="noreferrer">
                        {group.label}
                    </a>
                ) : (
                    group.label
                )}
            </h2>
            <ul className="board-rows">
                {group.rows.map((row) => (
                    <BoardRowItem
                        key={row.requirementKey}
                        row={row}
                        hasOpenCall={Boolean(row.factKey && callFactKeys.has(row.factKey))}
                    />
                ))}
            </ul>
        </section>
    );
}

function BoardRowItem({ row, hasOpenCall }: { row: BoardRow; hasOpenCall: boolean }) {
    return (
        <li className={`board-row is-${row.status}`}>
            <div className="board-row-main">
                <span className="board-status" aria-hidden="true">
                    {statusGlyph(row.status)}
                </span>
                <span className="board-status-label">{statusLabel(row.status)}</span>
                <span className="board-text">{row.text}</span>
            </div>
            {row.status === "broken" ? (
                <div className="board-row-detail">
                    {row.evidence ? <p className="board-evidence">{row.evidence}</p> : null}
                    <p className="board-meta">
                        {row.sinceWhen ? `stopped working ${timeAgo(row.sinceWhen)}` : null}
                        {row.sinceCommit ? ` · commit ${row.sinceCommit.slice(0, 7)}` : null}
                        {hasOpenCall ? (
                            <span className="board-meta-call"> · waiting on your call ↑</span>
                        ) : null}
                    </p>
                    <AlertButton row={row} />
                </div>
            ) : row.status === "works" && row.sinceWhen ? (
                <p className="board-meta">checked {timeAgo(row.sinceWhen)}</p>
            ) : null}
        </li>
    );
}

function AlertButton({ row }: { row: BoardRow }) {
    const alert = trpc.contractAlert.useMutation();
    const [sent, setSent] = useState(false);
    const notConfigured =
        alert.data && alert.data.configured === false ? (alert.data.reason ?? null) : null;
    const label = sent
        ? "Team alerted"
        : alert.isError || notConfigured
          ? "Alert failed — retry"
          : alert.isPending
            ? "Alerting…"
            : "Alert the team";
    return (
        <span className="board-alert-wrap">
            <button
                type="button"
                className="board-alert"
                disabled={alert.isPending || sent}
                onClick={() =>
                    alert.mutate(
                        {
                            text: `[${row.ticket?.id ?? "contract"}] Broken promise: ${row.text}`,
                            detail: row.evidence ?? "",
                            requirementKey: row.requirementKey,
                        },
                        {
                            onSuccess: (result) => {
                                if (result.configured && result.delivered) setSent(true);
                            },
                        },
                    )
                }
            >
                {label}
            </button>
            {notConfigured && !sent ? (
                <output className="board-alert-hint">{notConfigured}</output>
            ) : null}
        </span>
    );
}

function BoardEmptyState({
    onImport,
    pending,
    error,
    result,
}: {
    onImport: (input: { text?: string; filePath?: string }) => void;
    pending: boolean;
    error: string | null;
    result: { imported: number; skipped: number } | null;
}) {
    const [text, setText] = useState("");
    const [filePath, setFilePath] = useState("");
    const canImport = text.trim().length > 0 || filePath.trim().length > 0;

    return (
        <section className="board-empty" aria-labelledby="board-empty-title">
            <h2 id="board-empty-title" className="board-empty-title">
                No requirements yet
            </h2>
            <p>
                Paste the acceptance criteria from your tickets (or point at a file in this
                project), and this board becomes the delta between what was promised and what the
                app verifiably does.
            </p>
            <textarea
                className="board-import-text"
                rows={5}
                placeholder={
                    'AC-1: submitting the reservation form empty shows "Please add your name"\nRoute: /reservations.html'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Acceptance criteria text"
            />
            <div className="board-import-actions">
                <input
                    type="text"
                    className="board-import-path"
                    placeholder="or a file path, e.g. requirements.md"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    aria-label="Requirements file path"
                />
                <button
                    type="button"
                    className="board-import-btn"
                    disabled={!canImport || pending}
                    onClick={() =>
                        onImport({ text: text || undefined, filePath: filePath || undefined })
                    }
                >
                    {pending ? "Importing…" : "Import requirements"}
                </button>
            </div>
            {error ? (
                <p className="board-import-error" role="alert">
                    {error}
                </p>
            ) : null}
            {result ? (
                <output className="board-import-result">
                    {result.imported} imported
                    {result.skipped ? ` · ${result.skipped} duplicate skipped` : ""}
                </output>
            ) : null}
        </section>
    );
}
