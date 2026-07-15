import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavRail } from "../nav-rail";

const baseProps = {
    activeView: "testing" as const,
    activeSidebarTab: "chat" as const,
    sidebarCollapsed: false,
    onNavigate: vi.fn(),
    onToggleCollapse: vi.fn(),
};

describe("NavRail attention dots", () => {
    it("renders no attention dots when nothing needs attention", () => {
        render(<NavRail {...baseProps} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(0);
    });

    it("shows a dot on chat when a HITL approval is pending", () => {
        render(<NavRail {...baseProps} attention={{ chat: true }} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(1);
        expect(screen.getByLabelText("chat, needs attention")).toBeDefined();
    });

    it("shows a dot on files when a test is broken", () => {
        render(<NavRail {...baseProps} attention={{ files: true }} />);
        expect(screen.getByLabelText("files, needs attention")).toBeDefined();
        expect(screen.queryByLabelText("chat, needs attention")).toBeNull();
    });

    it("shows a dot on discovery when it's paused or has unresolved blockers", () => {
        render(<NavRail {...baseProps} attention={{ discovery: true }} />);
        expect(screen.getByLabelText("discovery, needs attention")).toBeDefined();
    });

    it("can show multiple dots at once", () => {
        render(<NavRail {...baseProps} attention={{ chat: true, files: true, discovery: true }} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(3);
    });

    it("falls back to plain labels when attention is undefined", () => {
        render(<NavRail {...baseProps} attention={undefined} />);
        expect(screen.getByLabelText("chat")).toBeDefined();
        expect(screen.getByLabelText("files")).toBeDefined();
        expect(screen.getByLabelText("discovery")).toBeDefined();
    });
});
