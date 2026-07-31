import { z } from "zod";
import { appFor, resolveProjectPath } from "./app-context";
import { procedure } from "./trpc";

export const indexingRouter = {
    buildCodeGraph: procedure
        .input(
            z.object({
                path: z.string().optional(),
                includeTests: z.boolean().default(true),
                extensions: z.array(z.string()).optional(),
                useGitignore: z.boolean().default(true),
                persist: z.boolean().default(true),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).indexing.buildCodeGraph(input)),

    getGraphStats: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => appFor(ctx).indexing.getGraphStats(input)),

    getFileChangeBump: procedure.query(({ ctx }) => appFor(ctx).indexing.getFileChangeBump()),

    getGraphFiles: procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(1000),
                offset: z.number().default(0),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).indexing.getGraphFiles(input)),

    getFileDependencies: procedure
        .input(
            z.object({
                path: z.string().optional(),
                filePath: z.string(),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).indexing.getFileDependencies(input)),

    getFileContent: procedure
        .input(z.object({ filePath: z.string() }))
        .query(({ input, ctx }) => appFor(ctx).indexing.getFileContent(input)),

    generateEmbeddings: procedure
        .input(
            z.object({
                path: z.string().optional(),
                forceRegenerate: z.boolean().default(false),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).indexing.generateEmbeddings(input)),

    searchCode: procedure
        .input(
            z.object({
                path: z.string().optional(),
                query: z.string(),
                limit: z.number().default(10),
                chunkTypes: z.array(z.enum(["function", "class", "file", "type"])).optional(),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).indexing.searchCode(input)),

    getEmbeddingsStats: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => appFor(ctx).indexing.getEmbeddingsStats(input)),

    getAffectedTests: procedure
        .input(
            z.object({
                changedFiles: z.array(z.string()),
                path: z.string().optional(),
            }),
        )
        .query(({ input, ctx }) => appFor(ctx).indexing.getAffectedTests(input)),

    reindexFiles: procedure
        .input(
            z.object({
                files: z.array(z.string()),
                path: z.string().optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).indexing.reindexFiles(input)),

    syncTicket: procedure
        .input(
            z.object({
                ticketId: z.string().optional(),
                path: z.string().optional(),
            }),
        )
        .mutation(({ input, ctx }) =>
            appFor(ctx).indexing.syncTicket({
                ...input,
                path: resolveProjectPath(ctx, input.path),
            }),
        ),

    getTicketStatus: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => appFor(ctx).indexing.getTicketStatus(input)),
};
