import { isRaikenError, normalizeToRaikenError } from "./normalize";
import type { RaikenError } from "./raiken-error";
import { redactSecrets, SECRET_KEY_PATTERN } from "./redact";
import type { RaikenErrorDetails, RaikenErrorDetailValue, SafeRaikenErrorPayload } from "./types";

// Lives in ./redact (shared with normalize.ts); re-exported here so the
// existing `errors/serialize` import surface doesn't move.
export { redactSecrets };

function redactDetailValue(key: string, value: RaikenErrorDetailValue): RaikenErrorDetailValue {
    if (SECRET_KEY_PATTERN.test(key)) {
        return "[REDACTED]";
    }
    if (typeof value === "string") {
        return redactSecrets(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) =>
            typeof entry === "string" ? redactSecrets(entry) : entry,
        ) as RaikenErrorDetailValue;
    }
    return value;
}

/** Redact secret-like keys/values from structured details. */
export function redactErrorDetails(
    details: RaikenErrorDetails | undefined,
): RaikenErrorDetails | undefined {
    if (!details) return undefined;
    const redacted: RaikenErrorDetails = {};
    for (const [key, value] of Object.entries(details)) {
        redacted[key] = redactDetailValue(key, value);
    }
    return redacted;
}

/**
 * Serialize a {@link RaikenError} (or unknown) into a client-safe payload.
 * Never includes stack traces, raw cause chains, or unredacted secrets.
 */
export function serializeSafeClientError(error: unknown): SafeRaikenErrorPayload {
    const raiken = isRaikenError(error) ? error : normalizeToRaikenError(error);
    return {
        code: raiken.code,
        category: raiken.category,
        message: redactSecrets(raiken.message),
        retryable: raiken.retryable,
        operationId: raiken.operationId,
        correlationId: raiken.correlationId,
        details: redactErrorDetails(raiken.details),
    };
}

/** HTTP/Fastify JSON body shape for safe errors (legacy `error` string + optional metadata). */
export function serializeSafeHttpErrorBody(error: unknown): {
    error: string;
    /** @deprecated Use `raiken.message`; retained for HTTP client compatibility. */
    detail: string;
    raiken: SafeRaikenErrorPayload;
} {
    const raiken = serializeSafeClientError(error);
    return { error: raiken.message, detail: raiken.message, raiken };
}

export type { SafeRaikenErrorPayload };
