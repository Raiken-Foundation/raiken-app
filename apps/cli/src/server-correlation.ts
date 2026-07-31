import type { CorrelationContext } from "@raiken/core";
import { createCorrelationId, runWithCorrelationContext } from "@raiken/core";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

declare module "fastify" {
    interface FastifyRequest {
        /** Request-scoped correlation ids for hooks that run outside ALS scope. */
        raikenCorrelation?: CorrelationContext;
    }
}

export function buildRequestCorrelation(
    request: FastifyRequest,
    projectPath: string,
): CorrelationContext & { projectPath: string } {
    const headerCorrelation = request.headers["x-correlation-id"];
    return {
        correlationId:
            (typeof headerCorrelation === "string" && headerCorrelation) || createCorrelationId(),
        requestId: request.id,
        projectPath,
    };
}

function wrapRouteHandler(handler: RouteHandlerMethod, projectPath: string): RouteHandlerMethod {
    return function correlationScopedHandler(
        this: unknown,
        request: FastifyRequest,
        reply: FastifyReply,
    ) {
        const ctx = buildRequestCorrelation(request, projectPath);
        request.raikenCorrelation = ctx;
        return runWithCorrelationContext(ctx, () => handler.call(this, request, reply));
    };
}

/**
 * Wrap every route handler so concurrent requests each get an isolated ALS store.
 * Must be registered before routes (including tRPC) are added.
 */
export function registerCorrelationScope(fastify: FastifyInstance, projectPath: string): void {
    fastify.addHook("onRoute", (routeOptions) => {
        if (typeof routeOptions.handler === "function") {
            routeOptions.handler = wrapRouteHandler(routeOptions.handler, projectPath);
        }
    });
}
