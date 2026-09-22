import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TestFile } from "../../../components/code-editor";
import { emptySummary } from "../constants";
import { normalizeSpecFileName } from "../normalize-spec-file-name";
import {
    classifyRunResult,
    fromServerParsedRun,
    parseRunOutput,
    parseTextOutput,
    shouldAutoBuildGraph,
} from "../run-output-parser";
import { TestingRunControls } from "../testing-results-pane";
import { TestingSidebarPane } from "../testing-sidebar-pane";
import { isFileDirty } from "../use-test-files";

vi.mock("../../../components/files-sidebar", () => ({
    FilesSidebar: (props: Record<string, unknown>) => (
        <div data-testid="testing-sidebar" data-collapsed={String(props.collapsed)} />
    ),
}));

describe("testing run disposition", () => {
    it("does not classify a cancelled run as failed", () => {
        expect(classifyRunResult({ success: false, cancelled: true })).toBe("cancelled");
    });

    it("prioritizes a busy rejection over success state", () => {
        expect(classifyRunResult({ success: false, busy: true })).toBe("busy");
    });

    it("classifies a successful run as passed", () => {
        expect(classifyRunResult({ success: true })).toBe("passed");
    });

    it("classifies a failed run when not busy or cancelled", () => {
        expect(classifyRunResult({ success: false })).toBe("failed");
    });
});

describe("testing graph initialization", () => {
    it("builds once when a fresh project has no graph stats", () => {
        expect(shouldAutoBuildGraph(null, false, false)).toBe(true);
        expect(shouldAutoBuildGraph(null, true, false)).toBe(false);
    });

    it("does not loop when a completed build indexed zero files", () => {
        expect(shouldAutoBuildGraph({ totalFiles: 0 }, true, false)).toBe(false);
    });

    it("waits for the stats query before deciding", () => {
        expect(shouldAutoBuildGraph(undefined, false, false)).toBe(false);
    });
});

describe("run output adapter", () => {
    it("maps server parsedRun into dashboard result types", () => {
        const mapped = fromServerParsedRun({
            tests: [
                {
                    id: "1",
                    name: "login works",
                    suite: "auth",
                    status: "passed",
                    duration: 120,
                },
            ],
            summary: {
                suites: { passed: 1, failed: 0, total: 1 },
                tests: { passed: 1, failed: 0, total: 1 },
                timeSeconds: 1.2,
            },
        });

        expect(mapped.results[0].name).toBe("login works");
        expect(mapped.summary.time).toBe(1.2);
    });

    it("prefers parsedRun over stdout scraping", () => {
        const parsed = parseRunOutput({
            stdout: "✓ unrelated scrape\n",
            parsedRun: {
                tests: [
                    {
                        id: "a",
                        name: "from server",
                        suite: "suite",
                        status: "failed",
                    },
                ],
                summary: {
                    suites: { passed: 0, failed: 1, total: 1 },
                    tests: { passed: 0, failed: 1, total: 1 },
                    timeSeconds: 3,
                },
            },
        });

        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0].name).toBe("from server");
        expect(parsed.summary.tests.failed).toBe(1);
    });

    it("falls back to text scraping when parsedRun is absent", () => {
        const output = "  ✓ should load homepage (42ms)\n  1 passed (1.5s)";
        const scraped = parseTextOutput(output);
        expect(scraped.results[0].status).toBe("passed");
        expect(scraped.summary.tests.passed).toBe(1);
        expect(scraped.summary.time).toBe(1.5);
    });

    it("handles busy run output without fabricating failures", () => {
        const disposition = classifyRunResult({ busy: true, success: false });
        expect(disposition).toBe("busy");
        expect(parseRunOutput({ stdout: "" }).results).toEqual([]);
        expect(parseRunOutput({ stdout: "" }).summary).toEqual(emptySummary);
    });
});

describe("spec file naming", () => {
    it("keeps valid spec names unchanged", () => {
        expect(normalizeSpecFileName("login.spec.ts")).toBe("login.spec.ts");
    });

    it("sanitizes arbitrary tab titles for auto-save-on-run", () => {
        expect(normalizeSpecFileName("My Login Flow!", "test.describe('x')")).toBe(
            "my-login-flow.spec.ts",
        );
    });

    it("derives a stem from test.describe when the name is empty", () => {
        expect(normalizeSpecFileName("", "test.describe('Checkout Flow', () => {})")).toBe(
            "checkout-flow.spec.ts",
        );
    });
});

describe("dirty buffer protection", () => {
    it("detects unsaved edits against the saved baseline", () => {
        const baseline = new Map<string, string>([["f1", "original"]]);
        const savedContentRef = { current: baseline };
        const dirtyFile: TestFile = {
            id: "f1",
            name: "a.spec.ts",
            path: "e2e/a.spec.ts",
            content: "edited",
            status: "pending",
        };
        expect(isFileDirty(dirtyFile, savedContentRef)).toBe(true);
    });

    it("treats a file matching its baseline as clean", () => {
        const baseline = new Map<string, string>([["f1", "same"]]);
        const savedContentRef = { current: baseline };
        const cleanFile: TestFile = {
            id: "f1",
            name: "a.spec.ts",
            path: "e2e/a.spec.ts",
            content: "same",
            status: "pending",
        };
        expect(isFileDirty(cleanFile, savedContentRef)).toBe(false);
    });

    it("does not flag an empty buffer as dirty", () => {
        const baseline = new Map<string, string>([["f1", ""]]);
        const savedContentRef = { current: baseline };
        const emptyFile: TestFile = {
            id: "f1",
            name: "a.spec.ts",
            path: "e2e/a.spec.ts",
            content: "",
            status: "pending",
        };
        expect(isFileDirty(emptyFile, savedContentRef)).toBe(false);
    });
});

describe("run cancel controls", () => {
    it("renders stop button only while a run is active", () => {
        const { rerender } = render(
            <TestingRunControls isRunning={false} isCancelling={false} onCancel={() => {}} />,
        );
        expect(screen.queryByRole("button", { name: /stop test run/i })).toBeNull();

        rerender(<TestingRunControls isRunning isCancelling={false} onCancel={() => {}} />);
        const stopButton = screen.getByRole("button", { name: /stop test run/i });
        expect(stopButton).toBeDefined();
        expect((stopButton as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows stopping label while cancellation is pending", () => {
        render(<TestingRunControls isRunning isCancelling onCancel={() => {}} />);
        const stoppingButton = screen.getByRole("button", { name: /stopping/i });
        expect(stoppingButton).toBeDefined();
        expect((stoppingButton as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("sidebar always-mounted semantics", () => {
    it("always renders Sidebar inside the testing pane wrapper", () => {
        render(
            <TestingSidebarPane
                sidebarWidth={320}
                isResizing={false}
                onMouseDown={() => {}}
                onResizeKeyDown={() => {}}
                onSendMessage={() => {}}
                onFileSelect={() => {}}
                activeFilePath=""
                sidebarTab="chat"
                sidebarCollapsed={false}
            />,
        );
        expect(screen.getByTestId("testing-sidebar")).toBeDefined();
    });

    it("keeps Sidebar mounted when collapsed (visibility toggled upstream)", () => {
        render(
            <TestingSidebarPane
                sidebarWidth={320}
                isResizing={false}
                onMouseDown={() => {}}
                onResizeKeyDown={() => {}}
                onSendMessage={() => {}}
                onFileSelect={() => {}}
                activeFilePath="e2e/a.spec.ts"
                sidebarTab="files"
                sidebarCollapsed
            />,
        );
        const sidebar = screen.getByTestId("testing-sidebar");
        expect(sidebar).toBeDefined();
        expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    });
});
