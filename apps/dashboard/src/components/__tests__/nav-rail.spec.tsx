import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavRail } from "../nav-rail";

const baseProps = {
    activeView: "testing" as const,
    activeSidebarTab: "files" as const,
    sidebarCollapsed: false,
    onNavigate: vi.fn(),
    onToggleCollapse: vi.fn(),
};

describe("NavRail attention dots", () => {
    it("renders no attention dots when nothing needs attention", () => {
        render(<NavRail {...baseProps} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(0);
    });

    it("shows a dot on tests when a spec is broken", () => {
        render(<NavRail {...baseProps} attention={{ files: true }} />);
        expect(screen.getByLabelText("tests, needs attention")).toBeDefined();
    });

    it("shows a dot on contract when acquisition (discovery) needs attention", () => {
        render(<NavRail {...baseProps} attention={{ discovery: true }} />);
        expect(screen.getByLabelText("contract, needs attention")).toBeDefined();
    });

    it("can show multiple dots at once", () => {
        render(<NavRail {...baseProps} attention={{ files: true, discovery: true }} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(2);
    });

    it("falls back to plain labels when attention is undefined", () => {
        render(<NavRail {...baseProps} attention={undefined} />);
        expect(screen.getByLabelText("contract")).toBeDefined();
        expect(screen.getByLabelText("tests")).toBeDefined();
        expect(screen.getByLabelText("quality")).toBeDefined();
    });

    it("leads with the contract button", () => {
        render(<NavRail {...baseProps} />);
        const buttons = Array.from(document.querySelectorAll(".rail-btn"));
        const labels = buttons.map((b) => b.getAttribute("aria-label"));
        expect(labels.indexOf("contract")).toBe(0);
    });
});
