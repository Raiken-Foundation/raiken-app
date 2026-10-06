/**
 * Browser-safe board projection types.
 *
 * The canonical definitions live in `@raiken/core` (`contract/status.ts`);
 * this leaf mirrors them structurally so the dashboard never imports core
 * into a browser bundle. Drift is impossible to miss: the server-side
 * parity spec (`board-types-parity.server.spec.ts`) fails compilation the
 * moment the two shapes disagree.
 */

export type BoardStatus = "works" | "broken" | "not-checked";

export interface BoardTicket {
    id: string;
    provider: string | null;
    url: string | null;
}

export interface BoardRow {
    requirementKey: string;
    /** The requirement verbatim — the ticket's language, never raiken's. */
    text: string;
    status: BoardStatus;
    ticket: BoardTicket | null;
    /** Where the requirement came from — drives the plain group label. */
    source: "ticket" | "file" | "manual";
    neverRegress: boolean;
    /** Epoch ms of the event behind the status (last verify or violate). */
    sinceWhen: number | null;
    /** Commit the status was observed at, when ledger stamping is active. */
    sinceCommit: string | null;
    /** Plain-language evidence line for broken rows (the violation detail). */
    evidence: string | null;
    /** The observed fact behind the row, for linking into the workbench. */
    factKey: string | null;
}

export interface BoardReport {
    rows: BoardRow[];
    counts: { works: number; broken: number; notChecked: number };
    generatedAt: number;
    /** Live watcher heartbeat when `raiken contract watch` is running. */
    watch?: WatchHeartbeat | null;
    /**
     * Behavior changes awaiting a human decision, in Reader language. The
     * workbench asks "accept or regression?" — a product question the Reader
     * is usually the only person who can answer, so the board asks it plainly.
     */
    needsYourCall?: BoardCall[];
}

export interface BoardCall {
    reviewId: number;
    /** The observed fact behind the change — links the call to its board row. */
    factKey: string;
    /** The promise this change belongs to, when an intent matches it. */
    requirementText: string | null;
    route: string;
    /** The behavior as recorded, in observable notation. */
    was: string;
    /** What verify actually saw (business-language detail). */
    observed: string;
    /** When the change was first observed. */
    sinceWhen: number;
}

export interface WatchHeartbeat {
    /** Epoch ms of the last completed verification cycle. */
    lastCheckAt: number;
    /** Cycle interval in seconds (from `contract watch --every`). */
    everySec: number;
    verified: number;
    violated: number;
}
