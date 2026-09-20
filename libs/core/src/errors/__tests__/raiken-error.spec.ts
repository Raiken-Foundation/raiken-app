import { describe, expect, it } from "vitest";
import { PathContainmentError } from "../../config/store";
import { DatabaseError } from "../../database/errors";
import {
    authError,
    cancelledError,
    configError,
    conflictError,
    externalError,
    internalError,
    isRaikenError,
    normalizeToRaikenError,
    notFoundError,
    persistenceError,
    RaikenError,
    redactSecrets,
    serializeSafeClientError,
    timeoutError,
    unknownError,
    validationError,
} from "../index";

describe("RaikenError", () => {
    it("carries stable domain metadata", () => {
        const err = conflictError("Discovery already running.", {
            code: "DISCOVERY_ALREADY_RUNNING",
            operationId: "disc-1",
            retryable: true,
        });
        expect(err).toBeInstanceOf(RaikenError);
        expect(err.code).toBe("DISCOVERY_ALREADY_RUNNING");
        expect(err.category).toBe("conflict");
        expect(err.retryable).toBe(true);
        expect(err.operationId).toBe("disc-1");
        expect(isRaikenError(err)).toBe(true);
    });

    it("withMetadata preserves code/category", () => {
        const err = validationError("Bad input").withMetadata({ operationId: "op-2" });
        expect(err.operationId).toBe("op-2");
        expect(err.code).toBe("VALIDATION_FAILED");
    });
});

describe("normalizeToRaikenError", () => {
    it("passes through RaikenError", () => {
        const original = authError("Sign in required.");
        expect(normalizeToRaikenError(original)).toBe(original);
    });

    it("maps PathContainmentError to validation", () => {
        const err = new PathContainmentError("../etc/passwd", "/proj");
        const normalized = normalizeToRaikenError(err);
        expect(normalized.code).toBe("PATH_OUTSIDE_PROJECT");
        expect(normalized.category).toBe("validation");
    });

    it("maps DatabaseError to persistence", () => {
        const err = new DatabaseError("sqlite failed");
        const normalized = normalizeToRaikenError(err);
        expect(normalized.code).toBe("DATABASE_ERROR");
        expect(normalized.category).toBe("persistence");
        expect(normalized.message).not.toContain("sqlite");
    });

    it("maps AbortError to cancelled", () => {
        const err = new DOMException("Aborted", "AbortError");
        const normalized = normalizeToRaikenError(err);
        expect(normalized.category).toBe("cancelled");
        expect(normalized.code).toBe("CANCELLED");
    });

    it("maps timeout-like errors", () => {
        const err = new Error("Request timed out after 30s");
        err.name = "TimeoutError";
        const normalized = normalizeToRaikenError(err);
        expect(normalized.category).toBe("timeout");
    });

    it("maps lock conflict messages", () => {
        const err = new Error("discovery operation (PID 42) is already active for this project.");
        const normalized = normalizeToRaikenError(err);
        expect(normalized.code).toBe("OPERATION_BUSY");
        expect(normalized.category).toBe("conflict");
    });

    it("keeps unknown error messages but redacts secrets", () => {
        const normalized = normalizeToRaikenError(new Error("super secret sk-or-v1-abc123token"));
        expect(normalized.code).toBe("INTERNAL_ERROR");
        expect(normalized.message).toContain("super secret");
        expect(normalized.message).not.toContain("sk-or-v1-abc123token");
        expect(normalized.message).toContain("[REDACTED]");
    });

    it("falls back to the generic message when there is none", () => {
        const normalized = normalizeToRaikenError(new Error(""));
        expect(normalized.message).toBe("An unexpected error occurred.");
    });
});

describe("serializeSafeClientError", () => {
    it("never exposes stack or raw cause", () => {
        const cause = new Error("internal sqlite: /var/db");
        const err = cancelledError("Stopped.", { cause });
        const safe = serializeSafeClientError(err);
        expect(JSON.stringify(safe)).not.toContain("stack");
        expect(JSON.stringify(safe)).not.toContain("sqlite");
        expect(safe.message).toBe("Stopped.");
        expect(safe.code).toBe("CANCELLED");
    });

    it("redacts secrets in messages and details", () => {
        const err = validationError("Invalid key sk-or-v1-deadbeef", {
            details: { apiKey: "sk-or-v1-deadbeef", path: "ai.model" },
        });
        const safe = serializeSafeClientError(err);
        expect(safe.message).not.toContain("sk-or-v1");
        expect(safe.message).toContain("[REDACTED]");
        expect(safe.details?.apiKey).toBe("[REDACTED]");
        expect(safe.details?.path).toBe("ai.model");
    });

    it("redacts standalone secret strings", () => {
        expect(redactSecrets("token=Bearer abc.def.ghi")).toContain("[REDACTED]");
    });
});

describe("factory defaults", () => {
    it("defaults retryable by category", () => {
        // retryable categories: conflict, timeout, external, persistence
        expect(conflictError("x").retryable).toBe(true);
        expect(timeoutError().retryable).toBe(true);
        expect(externalError("x").retryable).toBe(true);
        expect(persistenceError("x").retryable).toBe(true);

        // non-retryable categories
        expect(validationError("x").retryable).toBe(false);
        expect(configError("x").retryable).toBe(false);
        expect(authError("x").retryable).toBe(false);
        expect(notFoundError("x").retryable).toBe(false);
        expect(cancelledError().retryable).toBe(false);
        expect(internalError().retryable).toBe(false);
    });

    it("each factory sets its stable code/category/message defaults", () => {
        expect(validationError("x")).toMatchObject({
            code: "VALIDATION_FAILED",
            category: "validation",
        });
        expect(configError("x")).toMatchObject({ code: "CONFIG_INVALID", category: "config" });
        expect(authError("x")).toMatchObject({ code: "AUTH_REQUIRED", category: "auth" });
        expect(notFoundError("x")).toMatchObject({ code: "NOT_FOUND", category: "not_found" });
        expect(conflictError("x")).toMatchObject({
            code: "RESOURCE_CONFLICT",
            category: "conflict",
        });
        expect(externalError("x")).toMatchObject({
            code: "EXTERNAL_SERVICE",
            category: "external",
        });
        expect(persistenceError("x")).toMatchObject({
            code: "PERSISTENCE_FAILED",
            category: "persistence",
        });

        // Factories with message defaults
        expect(cancelledError()).toMatchObject({
            code: "CANCELLED",
            category: "cancelled",
            message: "Operation was cancelled.",
        });
        expect(timeoutError()).toMatchObject({
            code: "TIMEOUT",
            category: "timeout",
            message: "Operation timed out.",
        });
        expect(internalError()).toMatchObject({
            code: "INTERNAL_ERROR",
            category: "internal",
            message: "An unexpected error occurred.",
        });
        expect(unknownError()).toMatchObject({
            code: "UNKNOWN",
            category: "internal",
            message: "An unexpected error occurred.",
        });
    });

    it("accepts code overrides without changing category", () => {
        expect(validationError("x", { code: "INVALID_INPUT" }).code).toBe("INVALID_INPUT");
        expect(validationError("x", { code: "PATH_OUTSIDE_PROJECT" }).code).toBe(
            "PATH_OUTSIDE_PROJECT",
        );
        expect(authError("x", { code: "AUTH_INVALID" }).code).toBe("AUTH_INVALID");
        expect(conflictError("x", { code: "OPERATION_BUSY" }).code).toBe("OPERATION_BUSY");
        expect(notFoundError("x", { code: "FILE_NOT_FOUND" }).code).toBe("FILE_NOT_FOUND");
    });

    it("honours explicit retryable overrides", () => {
        expect(validationError("x", { retryable: true }).retryable).toBe(true);
        expect(conflictError("x", { retryable: false }).retryable).toBe(false);
        expect(authError("x", { retryable: true }).retryable).toBe(true);
        expect(internalError("x", { retryable: true }).retryable).toBe(true);
    });

    it("carries details, operationId, and correlationId through to the error", () => {
        const err = persistenceError("db down", {
            details: { table: "sessions" },
            operationId: "op-9",
            correlationId: "cid-9",
        });
        expect(err.details).toEqual({ table: "sessions" });
        expect(err.operationId).toBe("op-9");
        expect(err.correlationId).toBe("cid-9");
    });
});

describe("withMetadata", () => {
    it("overrides operationId/details and preserves the rest", () => {
        const err = conflictError("x", {
            operationId: "op-1",
            correlationId: "cid-1",
            details: { a: 1 },
        });
        const next = err.withMetadata({ operationId: "op-2", details: { b: 2 } });

        expect(next.operationId).toBe("op-2");
        expect(next.correlationId).toBe("cid-1"); // preserved
        expect(next.details).toEqual({ b: 2 }); // overridden
        expect(next.code).toBe("RESOURCE_CONFLICT"); // preserved
        expect(next.category).toBe("conflict"); // preserved
        expect(next.retryable).toBe(true); // preserved
        expect(next.message).toBe("x"); // preserved
    });

    it("preserves details when not overridden", () => {
        const err = conflictError("x", { details: { a: 1 } });
        expect(err.withMetadata({}).details).toEqual({ a: 1 });
    });
});

describe("RaikenError constructor", () => {
    it("preserves the cause chain", () => {
        const cause = new Error("root cause");
        const err = unknownError(cause);
        expect((err as Error & { cause?: unknown }).cause).toBe(cause);
    });
});
