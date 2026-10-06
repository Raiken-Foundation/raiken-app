import type { BoardRow } from "@raiken/shared";
import { useState } from "react";
import { trpc } from "../../utils/trpc";
import {
    type BoardGroup,
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
    const importMutation = trpc.contractImport.useMutation({
        onSettled: () => void utils.contractBoard.invalidate(),
    });

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

    return (
        <main className="board">
            <header className="board-head">
                <h1 className="board-h1">Status</h1>
                <p className="board-summary" aria-live="polite">
                    {summarize(data.counts)}
                </p>
                <a
                    className="board-register-toggle"
                    href="#/contract"
                    aria-label="Switch to the technical view of the same contract"
                >
                    Technical view →
                </a>
            </header>

            {data.watch ? (
                <p className="board-watch">
                    watching · last check {timeAgo(data.watch.lastCheckAt)} ·{" "}
                    {data.watch.violated > 0 ? `${data.watch.violated} broken` : "none broken"}
                </p>
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
                        />
                    ))}
                </div>
            )}
        </main>
    );
}

function BoardGroupSection({ group, highlight }: { group: BoardGroup; highlight: boolean }) {
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
                    <BoardRowItem key={row.requirementKey} row={row} />
                ))}
            </ul>
        </section>
    );
}

function BoardRowItem({ row }: { row: BoardRow }) {
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
