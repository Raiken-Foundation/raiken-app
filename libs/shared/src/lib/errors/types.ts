/**
 * Browser-safe error transport types — mirrored from `@raiken/core` without
 * importing core runtime (keeps dashboard bundles free of Node-only deps).
 */

export type RaikenErrorCategory =
    | "validation"
    | "config"
    | "auth"
    | "not_found"
    | "conflict"
    | "cancelled"
    | "timeout"
    | "external"
    | "persistence"
    | "internal";

export type RaikenErrorCode =
    | "VALIDATION_FAILED"
    | "INVALID_INPUT"
    | "PATH_OUTSIDE_PROJECT"
    | "CONFIG_INVALID"
    | "CONFIG_READ_FAILED"
    | "AUTH_REQUIRED"
    | "AUTH_INVALID"
    | "AUTH_STATE_INVALID"
    | "NOT_FOUND"
    | "FILE_NOT_FOUND"
    | "OPERATION_BUSY"
    | "DISCOVERY_ALREADY_RUNNING"
    | "RESOURCE_CONFLICT"
    | "CANCELLED"
    | "OPERATION_ABORTED"
    | "TIMEOUT"
    | "EXTERNAL_SERVICE"
    | "NETWORK_ERROR"
    | "DATABASE_ERROR"
    | "PERSISTENCE_FAILED"
    | "INTERNAL_ERROR"
    | "UNKNOWN";

/** Client-safe error payload from tRPC/HTTP responses. */
export interface ClientSafeRaikenError {
    code: RaikenErrorCode;
    category: RaikenErrorCategory;
    message: string;
    retryable: boolean;
    operationId?: string;
    correlationId?: string;
    details?: Record<string, string | number | boolean | null | string[] | number[]>;
}

/** tRPC `data` extension — safe for dashboard clients. */
export interface RaikenTrpcErrorData {
    raikenCode: RaikenErrorCode;
    retryable: boolean;
    operationId?: string;
    correlationId?: string;
    workflowId?: string;
    discoverySessionId?: string;
    category: RaikenErrorCategory;
}
