import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedArtifactImage } from "../artifacts/authenticated-artifact-image";
import { AuthenticatedArtifactLink } from "../artifacts/authenticated-artifact-link";
import { FailureDetails } from "../tree/failure-details";
import { TestList } from "../tree/test-list";
import { FixErrorAlert, FixTestButton } from "../analysis/repair-actions";
import * as apiAuth from "../../../utils/api-auth";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("AuthenticatedArtifactImage", () => {
    it("shows a loading placeholder then renders the fetched image", async () => {
        const blob = new Blob(["png"], { type: "image/png" });
        vi.spyOn(apiAuth, "fetchServerArtifact").mockResolvedValue(blob);
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");

        render(<AuthenticatedArtifactImage path="test-results/a.png" name="failure.png" />);
        expect(screen.getByLabelText("Loading failure.png")).toBeDefined();

        await waitFor(() => {
            expect(screen.getByRole("img", { name: "failure.png" })).toBeDefined();
        });
    });

    it("surfaces artifact load errors", async () => {
        vi.spyOn(apiAuth, "fetchServerArtifact").mockRejectedValue(new Error("403 forbidden"));
        render(<AuthenticatedArtifactImage path="../etc/passwd" name="blocked" />);

        await waitFor(() => {
            expect(screen.getByRole("alert").textContent).toContain("403 forbidden");
        });
    });
});

describe("AuthenticatedArtifactLink", () => {
    it("retries after an open failure", async () => {
        vi.spyOn(window, "open").mockReturnValue({
            opener: null,
            close: vi.fn(),
            location: { assign: vi.fn() },
        } as unknown as Window);
        const fetchMock = vi
            .spyOn(apiAuth, "fetchServerArtifact")
            .mockRejectedValueOnce(new Error("network"))
            .mockResolvedValueOnce(new Blob(["zip"]));
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");

        render(
            <AuthenticatedArtifactLink path="test-results/trace.zip" label="Open Trace" fileName="trace.zip" />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Open Trace" }));
        await waitFor(() => {
            expect(screen.getByText("Retry")).toBeDefined();
        });

        fireEvent.click(screen.getByText("Retry"));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});

describe("FailureDetails", () => {
    it("strips ANSI codes and renders location metadata", () => {
        render(
            <FailureDetails
                error={{
                    message: "\x1b[31mExpected true\x1b[0m",
                    snippet: "expect(x).toBe(true)",
                    location: { file: "/proj/e2e/login.spec.ts", line: 12, column: 4 },
                }}
            />,
        );

        expect(screen.getByText("Expected true")).toBeDefined();
        expect(screen.getByText("login.spec.ts:12:4")).toBeDefined();
        expect(screen.getByText("expect(x).toBe(true)")).toBeDefined();
    });
});

describe("repair action UX", () => {
    it("shows pending state while generating a fix", () => {
        render(<FixTestButton label="Fix with AI" isFixing onClick={() => {}} />);
        const button = screen.getByRole("button", { name: /Generating fix/i });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it("renders fix errors as alerts", () => {
        render(<FixErrorAlert message="Repair request failed" />);
        expect(screen.getByRole("alert").textContent).toContain("Repair request failed");
    });
});

describe("TestList keyboard semantics", () => {
    it("toggles selection on Enter and Space", () => {
        const onSelectTest = vi.fn();
        render(
            <TestList
                results={[
                    {
                        id: "1",
                        name: "logs in",
                        suite: "Auth",
                        status: "failed",
                    },
                ]}
                selectedTest={null}
                onSelectTest={onSelectTest}
            />,
        );

        const row = screen.getByRole("listitem");
        fireEvent.keyDown(row, { key: "Enter" });
        fireEvent.keyDown(row, { key: " " });
        expect(onSelectTest).toHaveBeenCalledTimes(2);
        expect(onSelectTest).toHaveBeenNthCalledWith(1, "1");
        expect(onSelectTest).toHaveBeenNthCalledWith(2, "1");
    });
});
