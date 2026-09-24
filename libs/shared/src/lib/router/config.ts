import { computeHealthStatus } from "@raiken/core";
import { z } from "zod";
import { clearSecretsInputSchema } from "../config-contract";
import { AI_PROVIDER_IDS } from "../config-public";
import { getRaikenVersion } from "../version";
import { appFor } from "./app-context";
import { procedure } from "./trpc";

export const configRouter = {
    getHealth: procedure.query(({ ctx }) =>
        computeHealthStatus(ctx.projectPath, { version: getRaikenVersion() }),
    ),

    getProjectInfo: procedure.query(({ ctx }) => ({
        path: ctx.projectPath,
        nodeVersion: process.version,
    })),

    getConfig: procedure.query(({ ctx }) => appFor(ctx).config.getPublicConfig()),

    updateConfig: procedure
        .input(
            z.object({
                config: z.record(z.string(), z.unknown()),
                clearSecrets: clearSecretsInputSchema,
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).config.updateConfig(input)),

    listAIProviders: procedure.query(({ ctx }) => appFor(ctx).config.listAIProviders()),

    fetchAIModels: procedure
        .input(
            z.object({
                provider: z.enum(AI_PROVIDER_IDS),
                baseURL: z.string().optional(),
                draftApiKey: z.string().min(1).optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).config.fetchAIModels(input)),
};
