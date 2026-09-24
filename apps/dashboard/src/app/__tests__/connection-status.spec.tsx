import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    ConnectionDegraded,
    ConnectionError,
    ConnectionNotReady,
    deriveConnectionFlags,
} from "../connection-status";

describe("connection status UI", () => {
    it("shows NOT READY overlay for blocking readiness failures", () => {
        render(<ConnectionNotReady checks={{ config: "invalid", database: "ok" }} />);
        expect(screen.getByText("NOT READY")).toBeTruthy();
        expect(screen.getByText(/config: invalid/)).toBeTruthy();
    });

    it("shows a dismissible DEGRADED pill for non-blocking capability limits", () => {
        render(<ConnectionDegraded checks={{ ai: "degraded", config: "missing" }} />);
        expect(screen.getByText("DEGRADED")).toBeTruthy();
        expect(screen.getByText(/ai: degraded/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText("dismiss degraded notice"));
        expect(screen.queryByText("DEGRADED")).toBeNull();
    });

    it("shows OFFLINE overlay when backend is unreachable", () => {
        render(<ConnectionError />);
        expect(screen.getByText("OFFLINE")).toBeTruthy();
    });
});

describe("deriveConnectionFlags", () => {
    it("separates offline, not_ready, and degraded", () => {
        expect(deriveConnectionFlags({ isError: true })).toEqual({
            isBackendDown: true,
            isBackendNotReady: false,
            isBackendDegraded: false,
        });
        expect(deriveConnectionFlags({ isError: false, data: { status: "not_ready" } })).toEqual({
            isBackendDown: false,
            isBackendNotReady: true,
            isBackendDegraded: false,
        });
        expect(deriveConnectionFlags({ isError: false, data: { status: "degraded" } })).toEqual({
            isBackendDown: false,
            isBackendNotReady: false,
            isBackendDegraded: true,
        });
    });
});
