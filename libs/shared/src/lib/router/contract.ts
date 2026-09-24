import { z } from "zod";
import { appFor } from "./app-context";
import { procedure } from "./trpc";

/**
 * Contract surface — portfolio queries plus the actions that make the
 * portfolio a tool: verify (re-observe), explore (chase uncovered
 * requirements), materialize (emit disposable specs). Long-running: all
 * three drive a real browser like startDiscovery/runTests do.
 */
export const contractRouter = {
    contractView: procedure.query(({ ctx }) => appFor(ctx).contract.view()),

    contractCoverage: procedure.query(({ ctx }) => appFor(ctx).contract.coverage()),

    contractFacts: procedure
        .input(z.object({ status: z.string().optional() }))
        .query(({ input, ctx }) =>
            appFor(ctx)
                .contract.view()
                .observed.filter((f) => (input.status ? f.status === input.status : true)),
        ),

    contractEvents: procedure
        .input(z.object({ factKey: z.string().optional() }).optional())
        .query(({ input, ctx }) => appFor(ctx).contract.factHistory(input?.factKey)),

    contractReviews: procedure
        .input(z.object({ status: z.enum(["pending", "accepted", "rejected"]).optional() }).optional())
        .query(({ input, ctx }) => appFor(ctx).contract.listReviews(input?.status)),

    contractResolveReview: procedure
        .input(z.object({ reviewId: z.number(), accept: z.boolean() }))
        .mutation(({ input, ctx }) =>
            appFor(ctx).contract.resolveReview(input.reviewId, input.accept),
        ),

    contractForgetFact: procedure
        .input(z.object({ factKey: z.string() }))
        .mutation(({ input, ctx }) => appFor(ctx).contract.forgetFact(input.factKey)),

    contractRestoreReview: procedure
        .input(z.object({ reviewId: z.number() }))
        .mutation(({ input, ctx }) => appFor(ctx).contract.restoreReview(input.reviewId)),

    contractVerify: procedure
        .input(z.object({ baseURL: z.string().optional() }).optional())
        .mutation(async ({ input, ctx }) => {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            return appFor(ctx).contract.verify({
                verifyAll: true,
                baseURL: input?.baseURL ?? null,
                storageStatePath: resolveAuthStorageStatePath(ctx.projectPath),
            });
        }),

    contractExplore: procedure.mutation(async ({ ctx }) => {
        const { resolveAIConfig, resolveAuthStorageStatePath } = await import("@raiken/core");
        return appFor(ctx).contract.explore({
            ai: resolveAIConfig(ctx.projectPath),
            storageStatePath: resolveAuthStorageStatePath(ctx.projectPath),
        });
    }),

    contractMaterialize: procedure
        .input(z.object({ outDir: z.string().optional() }).optional())
        .mutation(async ({ input, ctx }) => {
            const { resolveAuthStorageStatePath } = await import("@raiken/core");
            return appFor(ctx).contract.materialize({
                outDir: input?.outDir ?? ".raiken/materialized",
                storageStatePath: resolveAuthStorageStatePath(ctx.projectPath),
            });
        }),
};
