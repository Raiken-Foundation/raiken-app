import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavRail } from "../nav-rail";

const baseProps = {
    activeView: "workbench" as const,
    workbenchView: "contract" as const,
    onOpenWorkbench: vi.fn(),
    onNavigate: vi.fn(),
    sidebarCollapsed: false,
    onToggleCollapse: vi.fn(),
};

describe("NavRail — board-first, workbench behind", () => {
    it("renders no attention dots when nothing needs attention", () => {
        render(<NavRail {...baseProps} />);
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(0);
    });

    it("marks the workbench button as the one needing attention, naming the view", () => {
        render(<NavRail {...baseProps} attention={{ files: true }} />);
        expect(screen.getByLabelText(/workbench \(contract\), needs attention/)).toBeDefined();
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(1);
    });

    it("surfaces discovery attention on the workbench button too (one dot, either cause)", () => {
        render(<NavRail {...baseProps} attention={{ discovery: true }} />);
        expect(screen.getByLabelText(/needs attention/)).toBeDefined();
        expect(document.querySelectorAll(".rail-dot")).toHaveLength(1);
    });

    it("falls back to plain labels when attention is undefined", () => {
        render(<NavRail {...baseProps} attention={undefined} />);
        expect(screen.getByLabelText("status board")).toBeDefined();
        expect(screen.getByLabelText(/workbench \(contract\)/)).toBeDefined();
    });

    it("leads with the board button — the Reader's screen is the front door", () => {
        render(<NavRail {...baseProps} />);
        const buttons = Array.from(document.querySelectorAll(".rail-btn"));
        expect(buttons[0]?.getAttribute("aria-label")).toBe("status board");
        expect(buttons[1]?.getAttribute("aria-label")).toContain("workbench");
    });

    it("marks the active entry with aria-current", () => {
        const { rerender } = render(<NavRail {...baseProps} />);
        expect(
            screen.getByLabelText(/workbench \(contract\)/).getAttribute("aria-current"),
        ).toBe("page");
        expect(screen.getByLabelText("status board").getAttribute("aria-current")).toBeNull();

        rerender(
            <NavRail
                {...baseProps}
                activeView="board"
                workbenchView="contract"
            />,
        );
        expect(screen.getByLabelText("status board").getAttribute("aria-current")).toBe("page");
    });
});
