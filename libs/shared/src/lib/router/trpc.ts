import {
    createCorrelationId,
    normalizeToRaikenError,
    runWithCorrelationContext,
    safeProjectRef,
    serializeSafeClientError,
} from "@raiken/core";
import { initTRPC, TRPCError } from "@trpc/server";
import { buildRaikenTrpcErrorData, toTrpcError } from "../errors/trpc-adapter";

/** tRPC context: project path and request-scoped correlation ids. */
export interface Context {
    projectPath: string;
    correlationId?: string;
    requestId?: string;
}

export const t = initTRPC.context<Context>().create({
    errorFormatter({ shape, error }) {
        const source = error.cause ?? error;
        const safe = serializeSafeClientError(normalizeToRaikenError(source));
        const raikenData = buildRaikenTrpcErrorData(source);
        return {
            ...shape,
            message: safe.message,
            data: {
                ...shape.data,
                ...raikenData,
            },
        };
    },
});

/** Bind request-scoped correlation ids for the full procedure lifecycle. */
const correlationMiddleware = t.middleware(({ ctx, next }) =>
    runWithCorrelationContext(
        {
            correlationId: ctx.correlationId ?? createCorrelationId(),
            requestId: ctx.requestId,
            projectRef: safeProjectRef(ctx.projectPath),
        },
        () => next(),
    ),
);

/** Normalize domain errors at the transport boundary; unknown errors become safe internal errors. */
const errorBoundary = t.middleware(async ({ next }) => {
    const result = await next();
    if (result.ok === false) {
        const source =
            result.error instanceof TRPCError ? (result.error.cause ?? result.error) : result.error;
        throw toTrpcError(source);
    }
    return result;
});

/** Preferred procedure export — wraps handlers with error normalization. */
export const procedure = t.procedure.use(correlationMiddleware).use(errorBoundary);
