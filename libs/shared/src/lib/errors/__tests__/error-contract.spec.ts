import {
    authError,
    cancelledError,
    conflictError,
    internalError,
    normalizeToRaikenError,
    runWithCorrelationContext,
    serializeSafeClientError,
    timeoutError,
    validationError,
} from "@raiken/core";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { procedure, t } from "../../router/trpc";
import { parseTrpcClientErrorData } from "../client";
import { buildRaikenTrpcErrorData, raikenCategoryToTrpcCode, toTrpcError } from "../trpc-adapter";

describe("domain → tRPC adapter", () => {
    it("maps categories to stable tRPC codes", () => {
        expect(raikenCategoryToTrpcCode("validation")).toBe("BAD_REQUEST");
        expect(raikenCategoryToTrpcCode("config")).toBe("PRECONDITION_FAILED");
        expect(raikenCategoryToTrpcCode("auth")).toBe("UNAUTHORIZED");
        expect(raikenCategoryToTrpcCode("conflict")).toBe("CONFLICT");
        expect(raikenCategoryToTrpcCode("cancelled")).toBe("CLIENT_CLOSED_REQUEST");
        expect(raikenCategoryToTrpcCode("timeout")).toBe("TIMEOUT");
    });

    it("wraps RaikenError with safe metadata", () => {
        const domain = conflictError("Discovery already running.", {
            code: "DISCOVERY_ALREADY_RUNNING",
            operationId: "disc-99",
        });
        const trpc = toTrpcError(domain);
        expect(trpc).toBeInstanceOf(TRPCError);
        expect(trpc.code).toBe("CONFLICT");
        expect(trpc.message).toBe("Discovery already running.");
        const data = buildRaikenTrpcErrorData(domain);
        expect(data).toEqual({
            raikenCode: "DISCOVERY_ALREADY_RUNNING",
            retryable: true,
            operationId: "disc-99",
            correlationId: undefined,
            category: "conflict",
        });
    });

    it("normalizes unknown errors at the boundary (message kept, secret redacted)", () => {
        const trpc = toTrpcError(new Error("secret sk-or-v1-leaked"));
        expect(trpc.code).toBe("INTERNAL_SERVER_ERROR");
        expect(trpc.message).toContain("secret");
        expect(trpc.message).not.toContain("sk-or-v1");
    });

    it("attaches correlation ids from active context", () => {
        runWithCorrelationContext({ correlationId: "corr-42", projectPath: "/tmp/p" }, () => {
            const err = validationError("Bad input");
            const normalized = normalizeToRaikenError(err);
            expect(normalized.correlationId).toBe("corr-42");
        });
    });

    it("includes workflow and discovery ids from correlation context", () => {
        runWithCorrelationContext(
            { workflowId: "wf-7", discoverySessionId: "99", projectPath: "/tmp/p" },
            () => {
                const data = buildRaikenTrpcErrorData(
                    conflictError("Busy", { code: "OPERATION_BUSY" }),
                );
                expect(data.workflowId).toBe("wf-7");
                expect(data.discoverySessionId).toBe("99");
            },
        );
    });

    it("redacts secrets in serialized client payloads", () => {
        const err = authError("Bad token sk-ant-secret123", {
            details: { apiKey: "sk-ant-secret123" },
        });
        const safe = serializeSafeClientError(err);
        expect(safe.message).not.toContain("sk-ant");
        expect(safe.details?.apiKey).toBe("[REDACTED]");
    });
});

describe("tRPC procedure middleware contract", () => {
    const router = t.router({
        throwConflict: procedure.mutation(() => {
            throw conflictError("Project is busy.", { code: "OPERATION_BUSY" });
        }),
        throwUnknown: procedure.query(() => {
            throw new Error("raw internal boom");
        }),
    });

    it("surfaces safe TRPCError codes for domain errors", async () => {
        const caller = router.createCaller({ projectPath: "/tmp/proj" });
        try {
            await caller.throwConflict();
            expect.fail("expected throw");
        } catch (error) {
            const trpcError = error as TRPCError;
            expect(trpcError.code).toBe("CONFLICT");
            expect(trpcError.message).toBe("Project is busy.");
            const data = buildRaikenTrpcErrorData(trpcError.cause ?? trpcError);
            expect(data).toMatchObject({
                raikenCode: "OPERATION_BUSY",
                retryable: true,
                category: "conflict",
            });
        }
    });

    it("normalizes unknown procedure errors", async () => {
        const caller = router.createCaller({ projectPath: "/tmp/proj" });
        try {
            await caller.throwUnknown();
            expect.fail("expected throw");
        } catch (error) {
            const trpcError = error as TRPCError;
            expect(trpcError.code).toBe("INTERNAL_SERVER_ERROR");
            // The message is preserved (redacted); stack/cause still never leak.
            expect(trpcError.message).toBe("raw internal boom");
            const parsed = buildRaikenTrpcErrorData(trpcError.cause ?? trpcError);
            expect(parsed.raikenCode).toBe("INTERNAL_ERROR");
            expect(parsed.category).toBe("internal");
        }
    });
});

describe("dashboard-safe client parsing", () => {
    it("parses Raiken metadata from tRPC error data", () => {
        const data = buildRaikenTrpcErrorData(
            timeoutError("Timed out waiting for discovery.", { operationId: "op-1" }),
        );
        const parsed = parseTrpcClientErrorData(data);
        expect(parsed?.raikenCode).toBe("TIMEOUT");
        expect(parsed?.retryable).toBe(true);
        expect(parsed?.operationId).toBe("op-1");
    });

    it("parses workflow and discovery session ids from tRPC error data", () => {
        const parsed = parseTrpcClientErrorData({
            raikenCode: "OPERATION_BUSY",
            retryable: true,
            category: "conflict",
            workflowId: "wf-1",
            discoverySessionId: "42",
        });
        expect(parsed?.workflowId).toBe("wf-1");
        expect(parsed?.discoverySessionId).toBe("42");
    });

    it("returns null for legacy error data without Raiken fields", () => {
        expect(parseTrpcClientErrorData({ code: "INTERNAL_SERVER_ERROR" })).toBeNull();
    });
});

describe("lock / cancel / timeout mapping", () => {
    it("maps lock holder message to conflict metadata", () => {
        const normalized = normalizeToRaikenError(
            new Error("discovery operation (PID 9) is already active for this project."),
        );
        const data = buildRaikenTrpcErrorData(normalized);
        expect(data.category).toBe("conflict");
        expect(data.raikenCode).toBe("OPERATION_BUSY");
    });

    it("maps AbortError to cancelled", () => {
        const data = buildRaikenTrpcErrorData(cancelledError("Stopped."));
        expect(data.category).toBe("cancelled");
        expect(data.raikenCode).toBe("CANCELLED");
    });

    it("maps timeout domain errors", () => {
        const data = buildRaikenTrpcErrorData(timeoutError("Request timed out."));
        expect(data.category).toBe("timeout");
        expect(data.raikenCode).toBe("TIMEOUT");
    });
});

describe("validation → BAD_REQUEST contract", () => {
    it("preserves user-safe validation messages", () => {
        const trpc = toTrpcError(
            validationError("Report output directory must be inside the project."),
        );
        expect(trpc.code).toBe("BAD_REQUEST");
        expect(trpc.message).toContain("inside the project");
    });

    it("does not leak internal validation cause", () => {
        const trpc = toTrpcError(
            internalError("safe", { cause: new Error("sqlite stack trace here") }),
        );
        expect(JSON.stringify(trpc)).not.toContain("stack trace");
    });
});
