import type { RaikenErrorCategory } from "@raiken/core";
import {
    correlationFields,
    isRaikenError,
    normalizeToRaikenError,
    serializeSafeClientError,
} from "@raiken/core";
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import type { RaikenTrpcErrorData } from "./types";

export type { RaikenTrpcErrorData } from "./types";

const CATEGORY_TO_TRPC: Record<RaikenErrorCategory, TRPC_ERROR_CODE_KEY> = {
    validation: "BAD_REQUEST",
    config: "PRECONDITION_FAILED",
    auth: "UNAUTHORIZED",
    not_found: "NOT_FOUND",
    conflict: "CONFLICT",
    cancelled: "CLIENT_CLOSED_REQUEST",
    timeout: "TIMEOUT",
    external: "BAD_GATEWAY",
    persistence: "INTERNAL_SERVER_ERROR",
    internal: "INTERNAL_SERVER_ERROR",
};

/** Map Raiken domain category to tRPC error code. */
export function raikenCategoryToTrpcCode(category: RaikenErrorCategory): TRPC_ERROR_CODE_KEY {
    return CATEGORY_TO_TRPC[category];
}

/** Convert any error into a TRPCError with Raiken metadata in `data`. */
export function toTrpcError(error: unknown): TRPCError {
    const raiken = normalizeToRaikenError(error);
    const safe = serializeSafeClientError(raiken);
    return new TRPCError({
        code: raikenCategoryToTrpcCode(safe.category),
        message: safe.message,
        cause: isRaikenError(error) ? error : raiken,
    });
}

/** Build tRPC errorFormatter `data` extension without breaking existing shape fields. */
export function buildRaikenTrpcErrorData(error: unknown): RaikenTrpcErrorData {
    const safe = serializeSafeClientError(error);
    const ctx = correlationFields();
    return {
        raikenCode: safe.code,
        retryable: safe.retryable,
        operationId: safe.operationId,
        correlationId: safe.correlationId,
        workflowId: ctx.workflowId,
        discoverySessionId: ctx.discoverySessionId,
        category: safe.category,
    };
}
