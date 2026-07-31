/** Stable domain categories for production error taxonomy. */
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

/** Stable domain codes surfaced to clients (never rename once shipped). */
export type RaikenErrorCode =
    // validation / usage
    | "VALIDATION_FAILED"
    | "INVALID_INPUT"
    | "PATH_OUTSIDE_PROJECT"
    // config
    | "CONFIG_INVALID"
    | "CONFIG_READ_FAILED"
    // auth
    | "AUTH_REQUIRED"
    | "AUTH_INVALID"
    | "AUTH_STATE_INVALID"
    // not found
    | "NOT_FOUND"
    | "FILE_NOT_FOUND"
    // conflict / busy / lock
    | "OPERATION_BUSY"
    | "DISCOVERY_ALREADY_RUNNING"
    | "RESOURCE_CONFLICT"
    // cancelled
    | "CANCELLED"
    | "OPERATION_ABORTED"
    // timeout
    | "TIMEOUT"
    // external dependency
    | "EXTERNAL_SERVICE"
    | "NETWORK_ERROR"
    // persistence
    | "DATABASE_ERROR"
    | "PERSISTENCE_FAILED"
    // internal / unknown
    | "INTERNAL_ERROR"
    | "UNKNOWN";

export type RaikenErrorDetailValue = string | number | boolean | null | string[] | number[];

/** Non-secret structured metadata safe to expose after redaction. */
export type RaikenErrorDetails = Record<string, RaikenErrorDetailValue>;

/** Client-safe error payload — never includes raw cause, stack, or secrets. */
export interface SafeRaikenErrorPayload {
    code: RaikenErrorCode;
    category: RaikenErrorCategory;
    message: string;
    retryable: boolean;
    operationId?: string;
    correlationId?: string;
    details?: RaikenErrorDetails;
}

export interface RaikenErrorInit {
    code: RaikenErrorCode;
    category: RaikenErrorCategory;
    /** User-safe message (never include secrets or stack traces). */
    message: string;
    /** Internal cause — never serialized to clients by default. */
    cause?: unknown;
    details?: RaikenErrorDetails;
    retryable?: boolean;
    operationId?: string;
    correlationId?: string;
}
