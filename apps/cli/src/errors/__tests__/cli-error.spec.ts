import {
    authError,
    cancelledError,
    configError,
    conflictError,
    timeoutError,
    validationError,
} from "@raiken/core";
import { describe, expect, it, vi } from "vitest";
import { withThrowExit } from "../../repl/exit";
import {
    CLI_EXIT,
    handleCliError,
    mapErrorToCliExitCode,
    renderCliError,
    safeCliErrorMessage,
} from "../index";

describe("CLI exit-code policy", () => {
    it("maps validation to usage exit code", () => {
        expect(mapErrorToCliExitCode(validationError("Bad flag"))).toBe(CLI_EXIT.USAGE);
    });

    it("maps auth/config categories to config/auth exit code", () => {
        expect(mapErrorToCliExitCode(authError("Sign in required"))).toBe(CLI_EXIT.CONFIG_AUTH);
        expect(mapErrorToCliExitCode(configError("Invalid config"))).toBe(CLI_EXIT.CONFIG_AUTH);
    });

    it("maps conflict/busy to exit code 4", () => {
        expect(mapErrorToCliExitCode(conflictError("Busy", { code: "OPERATION_BUSY" }))).toBe(
            CLI_EXIT.BUSY_CONFLICT,
        );
    });

    it("maps timeout to 124", () => {
        expect(mapErrorToCliExitCode(timeoutError())).toBe(CLI_EXIT.TIMEOUT);
    });

    it("maps cancelled to 130", () => {
        expect(mapErrorToCliExitCode(cancelledError())).toBe(CLI_EXIT.CANCELLED);
    });

    it("maps unknown internal errors to runtime failure", () => {
        expect(mapErrorToCliExitCode(new Error("boom"))).toBe(CLI_EXIT.RUNTIME_FAILURE);
    });
});

describe("CLI error rendering", () => {
    it("keeps trusted CLI messages while redacting embedded credentials", () => {
        expect(safeCliErrorMessage("No prompt provided: sk-or-v1-deadbeef")).toBe(
            "No prompt provided: [REDACTED]",
        );
    });

    it("renders safe messages without secrets", () => {
        const rendered = renderCliError(validationError("Invalid key sk-or-v1-deadbeef"), {
            label: "Config",
        });
        expect(rendered).toContain("Config:");
        expect(rendered).not.toContain("sk-or-v1");
        expect(rendered).toContain("[REDACTED]");
    });

    it("includes retry hint when requested", () => {
        const rendered = renderCliError(conflictError("Busy"), {
            showRetryHint: true,
        });
        expect(rendered.toLowerCase()).toContain("retryable");
    });
});

describe("lock conflict CLI mapping", () => {
    it("maps operation lock holder to busy exit code", () => {
        expect(
            mapErrorToCliExitCode(
                conflictError("discovery operation is already active for this project.", {
                    code: "OPERATION_BUSY",
                }),
            ),
        ).toBe(CLI_EXIT.BUSY_CONFLICT);
    });
});

describe("handleCliError wrapper", () => {
    it("maps typed errors without exitCode override", async () => {
        await expect(
            withThrowExit(async () => {
                handleCliError(conflictError("Project is busy.", { code: "OPERATION_BUSY" }));
            }),
        ).resolves.toBe(CLI_EXIT.BUSY_CONFLICT);

        await expect(
            withThrowExit(async () => {
                handleCliError(authError("Sign in required."));
            }),
        ).resolves.toBe(CLI_EXIT.CONFIG_AUTH);

        await expect(
            withThrowExit(async () => {
                handleCliError(validationError("Bad flag."));
            }),
        ).resolves.toBe(CLI_EXIT.USAGE);

        await expect(
            withThrowExit(async () => {
                handleCliError(timeoutError("Timed out."));
            }),
        ).resolves.toBe(CLI_EXIT.TIMEOUT);

        await expect(
            withThrowExit(async () => {
                handleCliError(cancelledError());
            }),
        ).resolves.toBe(CLI_EXIT.CANCELLED);
    });

    it("maps unknown errors to runtime failure", async () => {
        await expect(
            withThrowExit(async () => {
                handleCliError(new Error("unexpected"));
            }),
        ).resolves.toBe(CLI_EXIT.RUNTIME_FAILURE);
    });

    it("honours explicit exitCode when contract requires a fixed code", async () => {
        await expect(
            withThrowExit(async () => {
                handleCliError(conflictError("busy"), { exitCode: CLI_EXIT.RUNTIME_FAILURE });
            }),
        ).resolves.toBe(CLI_EXIT.RUNTIME_FAILURE);
    });

    it("prints safe label and message to stderr", async () => {
        const writes: string[] = [];
        const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            writes.push(args.map(String).join(" "));
        });
        await withThrowExit(async () => {
            handleCliError(configError("Invalid config."), { label: "Config" });
        });
        expect(writes.join(" ")).toContain("Config:");
        expect(writes.join(" ")).toContain("Invalid config");
        stderr.mockRestore();
    });
});
