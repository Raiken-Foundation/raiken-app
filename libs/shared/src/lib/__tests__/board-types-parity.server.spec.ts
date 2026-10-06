import type {
    BoardReport as CoreBoardReport,
    BoardRow as CoreBoardRow,
    BoardStatus as CoreBoardStatus,
    BoardTicket as CoreBoardTicket,
} from "@raiken/core";
import { describe, expect, it } from "vitest";
import type {
    BoardReport,
    BoardRow,
    BoardStatus,
    BoardTicket,
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
        // Referenced so the type assertions are actually checked.
        const parity: [StatusParity, TicketParity, RowParity, ReportParity] = [
            true,
            true,
            true,
            true,
        ];
        expect(parity).toEqual([true, true, true, true]);
    });
});
