import type { RaikenErrorInit } from "./types";

const RAIKEN_ERROR_BRAND = Symbol.for("raiken.error");

/** Typed production error with stable domain codes and safe client messaging. */
export class RaikenError extends Error {
    readonly [RAIKEN_ERROR_BRAND] = true as const;

    readonly code: RaikenErrorInit["code"];
    readonly category: RaikenErrorInit["category"];
    readonly details?: RaikenErrorInit["details"];
    readonly retryable: boolean;
    readonly operationId?: string;
    readonly correlationId?: string;

    constructor(init: RaikenErrorInit) {
        super(init.message);
        this.name = "RaikenError";
        this.code = init.code;
        this.category = init.category;
        this.details = init.details;
        this.retryable = init.retryable ?? defaultRetryable(init.category);
        this.operationId = init.operationId;
        this.correlationId = init.correlationId;
        if (init.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = init.cause;
        }
        Error.captureStackTrace?.(this, RaikenError);
    }

    withMetadata(
        partial: Pick<RaikenErrorInit, "operationId" | "correlationId" | "details">,
    ): RaikenError {
        return new RaikenError({
            code: this.code,
            category: this.category,
            message: this.message,
            cause: (this as Error & { cause?: unknown }).cause,
            details: partial.details ?? this.details,
            retryable: this.retryable,
            operationId: partial.operationId ?? this.operationId,
            correlationId: partial.correlationId ?? this.correlationId,
        });
    }
}

function defaultRetryable(category: RaikenErrorInit["category"]): boolean {
    switch (category) {
        case "conflict":
        case "timeout":
        case "external":
        case "persistence":
            return true;
        default:
            return false;
    }
}

export function validationError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "VALIDATION_FAILED" | "INVALID_INPUT" | "PATH_OUTSIDE_PROJECT";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "VALIDATION_FAILED",
        category: "validation",
        message,
        ...options,
    });
}

export function configError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "CONFIG_INVALID" | "CONFIG_READ_FAILED";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "CONFIG_INVALID",
        category: "config",
        message,
        retryable: options.retryable ?? false,
        ...options,
    });
}

export function authError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_STATE_INVALID";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "AUTH_REQUIRED",
        category: "auth",
        message,
        retryable: options.retryable ?? false,
        ...options,
    });
}

export function notFoundError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "NOT_FOUND" | "FILE_NOT_FOUND";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "NOT_FOUND",
        category: "not_found",
        message,
        retryable: options.retryable ?? false,
        ...options,
    });
}

export function conflictError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "OPERATION_BUSY" | "DISCOVERY_ALREADY_RUNNING" | "RESOURCE_CONFLICT";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "RESOURCE_CONFLICT",
        category: "conflict",
        message,
        retryable: options.retryable ?? true,
        ...options,
    });
}

export function cancelledError(
    message = "Operation was cancelled.",
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> = {},
): RaikenError {
    return new RaikenError({
        ...options,
        code: "CANCELLED",
        category: "cancelled",
        message,
        retryable: options.retryable ?? false,
    });
}

export function timeoutError(
    message = "Operation timed out.",
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> = {},
): RaikenError {
    return new RaikenError({
        code: "TIMEOUT",
        category: "timeout",
        message,
        retryable: options.retryable ?? true,
        ...options,
    });
}

export function externalError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "EXTERNAL_SERVICE" | "NETWORK_ERROR";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "EXTERNAL_SERVICE",
        category: "external",
        message,
        retryable: options.retryable ?? true,
        ...options,
    });
}

export function persistenceError(
    message: string,
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> & {
        code?: "DATABASE_ERROR" | "PERSISTENCE_FAILED";
    } = {},
): RaikenError {
    return new RaikenError({
        code: options.code ?? "PERSISTENCE_FAILED",
        category: "persistence",
        message,
        retryable: options.retryable ?? true,
        ...options,
    });
}

export function internalError(
    message = "An unexpected error occurred.",
    options: Omit<RaikenErrorInit, "code" | "category" | "message"> = {},
): RaikenError {
    return new RaikenError({
        code: "INTERNAL_ERROR",
        category: "internal",
        message,
        retryable: false,
        ...options,
    });
}

export function unknownError(cause?: unknown): RaikenError {
    return new RaikenError({
        code: "UNKNOWN",
        category: "internal",
        message: "An unexpected error occurred.",
        retryable: false,
        cause,
    });
}
