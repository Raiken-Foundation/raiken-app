/**
 * Browser-safe SSE agent stream event shapes for `/api/generate-test`.
 * Compatible with legacy servers that emit `error` as a plain string.
 */

/** Safe error metadata surfaced over SSE (never includes stack/secrets). */
export interface AgentStreamSafeError {
    message: string;
    code?: string;
    raikenCode?: string;
    retryable?: boolean;
    correlationId?: string;
    operationId?: string;
    workflowId?: string;
    discoverySessionId?: string;
}

export type AgentStreamErrorField = string | AgentStreamSafeError;

export interface SseAgentStreamEvent {
    chunk?: string;
    done?: boolean;
    error?: AgentStreamErrorField;
    workflowId?: string;
    correlationId?: string;
    runId?: string;
    operationId?: string;
}

/** Normalize legacy string or structured SSE error fields. */
export function parseAgentStreamError(error: AgentStreamErrorField): AgentStreamSafeError {
    if (typeof error === "string") {
        return { message: error };
    }
    if (typeof error === "object" && error !== null && typeof error.message === "string") {
        return {
            message: error.message,
            code: error.code ?? error.raikenCode,
            raikenCode: error.raikenCode ?? error.code,
            retryable: error.retryable,
            correlationId: error.correlationId,
            operationId: error.operationId,
            workflowId: error.workflowId,
            discoverySessionId: error.discoverySessionId,
        };
    }
    return { message: "An unexpected error occurred." };
}

/** User-visible message — never `[object Object]`. */
export function agentStreamErrorMessage(error: AgentStreamErrorField): string {
    return parseAgentStreamError(error).message;
}
