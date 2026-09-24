import { PathContainmentError } from "../config/store";
import { DatabaseError } from "../database/errors";
import { correlationFields } from "../observability/context";
import {
    cancelledError,
    conflictError,
    internalError,
    RaikenError,
    timeoutError,
    unknownError,
    validationError,
} from "./raiken-error";
import { redactSecrets } from "./redact";
import type { RaikenErrorCategory, RaikenErrorCode } from "./types";

const RAIKEN_ERROR_BRAND = Symbol.for("raiken.error");

/** Type guard for {@link RaikenError}. */
export function isRaikenError(error: unknown): error is RaikenError {
    return (
        error instanceof RaikenError ||
        (typeof error === "object" &&
            error !== null &&
            (error as Record<symbol, unknown>)[RAIKEN_ERROR_BRAND] === true)
    );
}

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    return false;
}

function isTimeoutError(error: unknown): boolean {
    if (error instanceof Error) {
        const name = error.name.toLowerCase();
        const message = error.message.toLowerCase();
        return (
            name.includes("timeout") ||
            message.includes("timed out") ||
            message.includes("timeout") ||
            (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        );
    }
    return false;
}

function isLockConflict(error: unknown): boolean {
    if ((error as { code?: string })?.code === "ELOCKED") return true;
    if (error instanceof Error) {
        return (
            error.message.includes("already active for this project") ||
            error.message.includes("already running") ||
            error.message.includes("Discovery already in progress")
        );
    }
    return false;
}

function mapPathContainment(error: PathContainmentError): RaikenError {
    return validationError(error.message, {
        code: "PATH_OUTSIDE_PROJECT",
        cause: error,
    });
}

function mapDatabaseError(error: DatabaseError): RaikenError {
    return new RaikenError({
        code: "DATABASE_ERROR",
        category: "persistence",
        message: "A database operation failed.",
        cause: error,
        retryable: true,
    });
}

function mapLockConflict(error: Error): RaikenError {
    return conflictError(error.message, {
        code: "OPERATION_BUSY",
        cause: error,
    });
}

function mapDiscoveryBusy(error: Error): RaikenError {
    return conflictError(error.message, {
        code: "DISCOVERY_ALREADY_RUNNING",
        cause: error,
    });
}

function inferFromGenericError(error: Error): RaikenError | null {
    const message = error.message;
    if (error instanceof PathContainmentError) return mapPathContainment(error);
    if (error instanceof DatabaseError) return mapDatabaseError(error);
    if (isLockConflict(error)) return mapLockConflict(error);
    if (
        message.includes("Discovery is already running") ||
        message.includes("Discovery already in progress") ||
        message.includes("Discovery is stopping")
    ) {
        return mapDiscoveryBusy(error);
    }
    if (error.name === "PathContainmentError") {
        return validationError(message, { code: "PATH_OUTSIDE_PROJECT", cause: error });
    }
    return null;
}

/**
 * Normalize any thrown value into a {@link RaikenError}.
 * Unknown values become internal errors whose message preserves the original
 * text (secret-redacted); stacks and cause chains never leak into it.
 */
export function normalizeToRaikenError(error: unknown): RaikenError {
    const normalized = normalizeToRaikenErrorCore(error);
    return attachCorrelationContext(normalized);
}

function attachCorrelationContext(error: RaikenError): RaikenError {
    const ctx = correlationFields();
    if (!ctx.correlationId && !ctx.operationId) return error;
    return error.withMetadata({
        correlationId: error.correlationId ?? ctx.correlationId,
        operationId: error.operationId ?? ctx.operationId,
    });
}

function normalizeToRaikenErrorCore(error: unknown): RaikenError {
    if (isRaikenError(error)) return error;
    if (isAbortError(error)) {
        return cancelledError(
            error instanceof Error
                ? error.message || "Operation was cancelled."
                : "Operation was cancelled.",
            { cause: error },
        );
    }
    if (isTimeoutError(error)) {
        return timeoutError(error instanceof Error ? error.message : "Operation timed out.", {
            cause: error,
        });
    }
    if (error instanceof Error) {
        const mapped = inferFromGenericError(error);
        if (mapped) return mapped;
        // Preserve the original message (secret-redacted) rather than the
        // opaque "An unexpected error occurred." — a local CLI/dashboard that
        // hides every message is undebuggable ("No package.json found…", a
        // first-party user-facing error, became the generic text). Stack and
        // cause stay attached, never in the message.
        const safeMessage = redactSecrets(error.message ?? "").trim();
        return internalError(safeMessage || "An unexpected error occurred.", { cause: error });
    }
    if (typeof error === "string") {
        const safeMessage = redactSecrets(error).trim();
        return internalError(safeMessage || "An unexpected error occurred.", { cause: error });
    }
    return unknownError(error);
}

/** Map category to a stable domain code when synthesizing from category alone. */
export function defaultCodeForCategory(category: RaikenErrorCategory): RaikenErrorCode {
    switch (category) {
        case "validation":
            return "VALIDATION_FAILED";
        case "config":
            return "CONFIG_INVALID";
        case "auth":
            return "AUTH_REQUIRED";
        case "not_found":
            return "NOT_FOUND";
        case "conflict":
            return "OPERATION_BUSY";
        case "cancelled":
            return "CANCELLED";
        case "timeout":
            return "TIMEOUT";
        case "external":
            return "EXTERNAL_SERVICE";
        case "persistence":
            return "PERSISTENCE_FAILED";
        case "internal":
            return "INTERNAL_ERROR";
    }
}
