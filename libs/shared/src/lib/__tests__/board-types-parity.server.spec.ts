import type {
    BoardCall as CoreBoardCall,
    BoardReport as CoreBoardReport,
    BoardRow as CoreBoardRow,
    BoardStatus as CoreBoardStatus,
    BoardTicket as CoreBoardTicket,
    WatchHeartbeat as CoreWatchHeartbeat,
} from "@raiken/core";
import { describe, expect, it } from "vitest";
import type {
    BoardCall,
    BoardReport,
    BoardRow,
    BoardStatus,
    BoardTicket,
    WatchHeartbeat,
} from "../board-types";
import { AssertExact, ExpectTrue } from "../type-parity";

/**
 * The browser-safe board types must be exactly the canonical core shapes —
 * if either side drifts, these assertions fail compilation and this file is
 * the place you learn about it, not the dashboard at runtime.
 */
describe("shared/core board type parity", () => {
    it("keeps the browser-safe board types exactly aligned with core", () => {
        type StatusParity = ExpectTrue<AssertExact<BoardStatus, CoreBoardStatus>>;
        type TicketParity = ExpectTrue<AssertExact<BoardTicket, CoreBoardTicket>>;
        type RowParity = ExpectTrue<AssertExact<BoardRow, CoreBoardRow>>;
        type ReportParity = ExpectTrue<AssertExact<BoardReport, CoreBoardReport>>;
        type WatchParity = ExpectTrue<AssertExact<WatchHeartbeat, CoreWatchHeartbeat>>;
        type CallParity = ExpectTrue<AssertExact<BoardCall, CoreBoardCall>>;
        // Referenced so the type assertions are actually checked.
        const parity: [
            StatusParity,
            TicketParity,
            RowParity,
            ReportParity,
            WatchParity,
            CallParity,
        ] = [true, true, true, true, true, true];
        expect(parity).toEqual([true, true, true, true, true, true]);
    });
});
