import { z } from "zod";
import { appFor } from "./app-context";
import { procedure } from "./trpc";

export const qualitySupportRouter = {
    runDoctor: procedure
        .input(
            z.object({
                testDirectory: z.string().optional(),
                extraDirectories: z.array(z.string()).optional(),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).quality.runDoctor(input)),

    writeContext: procedure
        .input(
            z.object({
                outputPath: z.string().optional(),
                maxRowsPerSection: z.number().int().positive().max(200).optional(),
                includeImpact: z.boolean().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).quality.writeContext(input)),

    runCover: procedure
        .input(
            z.object({
                target: z.string().min(1),
                ticketId: z.string().optional(),
                testDirectory: z.string().optional(),
                outputPath: z.string().optional(),
                dryRun: z.boolean().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).quality.runCover(input)),

    queryTrace: procedure
        .input(
            z.object({
                trace: z.string().min(1),
                minConfidence: z.number().min(0).max(1).optional(),
                limit: z.number().int().positive().max(100).optional(),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).quality.queryTrace(input)),

    runCi: procedure
        .input(
            z.object({
                base: z.string().optional(),
                head: z.string().optional(),
                staged: z.boolean().optional(),
                skipRun: z.boolean().optional(),
                confidenceThreshold: z.number().min(0).max(1).optional(),
                maxTests: z.number().int().positive().max(200).optional(),
                testTimeout: z.number().int().positive().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).quality.runCi(input)),
};
