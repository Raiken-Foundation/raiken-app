import { describe, expect, it } from "vitest";
import { PathContainmentError } from "../../config/store";
import { DatabaseError } from "../../database/errors";
import {
    authError,
    cancelledError,
    conflictError,
    isRaikenError,
    normalizeToRaikenError,
    RaikenError,
    redactSecrets,
    serializeSafeClientError,
    timeoutError,
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
    it("timeout and conflict are retryable by default", () => {
        expect(timeoutError().retryable).toBe(true);
        expect(conflictError("busy").retryable).toBe(true);
    });
});
