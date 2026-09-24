import type { RaikenErrorCategory, RaikenTrpcErrorData } from "./types";

/** Parse safe Raiken metadata from a tRPC client error shape. */
export function parseTrpcClientErrorData(data: unknown): RaikenTrpcErrorData | null {
    if (typeof data !== "object" || data === null) return null;
    const record = data as Partial<RaikenTrpcErrorData>;
    if (typeof record.raikenCode !== "string" || typeof record.retryable !== "boolean") {
        return null;
    }
    return {
        raikenCode: record.raikenCode as RaikenTrpcErrorData["raikenCode"],
        retryable: record.retryable,
        operationId: record.operationId,
        correlationId: record.correlationId,
        workflowId: record.workflowId,
        discoverySessionId: record.discoverySessionId,
        category: record.category as RaikenErrorCategory,
    };
}

/** User-facing message from a tRPC/fetch error, preferring safe Raiken message. */
export function formatTrpcClientErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}
