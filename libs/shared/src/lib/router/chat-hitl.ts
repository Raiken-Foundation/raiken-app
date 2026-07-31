import { z } from "zod";
import { appFor } from "./app-context";
import { procedure } from "./trpc";

export const chatHitlRouter = {
    continueHitlWorkflow: procedure
        .input(
            z.discriminatedUnion("action", [
                z.object({
                    workflowId: z.string().uuid(),
                    action: z.literal("save"),
                    decision: z.enum(["approve", "reject"]),
                    filePath: z.string().optional(),
                    avoidOverwrite: z.boolean().optional(),
                }),
                z.object({
                    workflowId: z.string().uuid(),
                    action: z.literal("run"),
                    decision: z.enum(["approve", "reject"]),
                }),
            ]),
        )
        .mutation(({ input, ctx }) => appFor(ctx).hitl.continue(input)),

    listActiveHitlWorkflows: procedure.query(({ ctx }) => appFor(ctx).hitl.listActive()),

    advanceHitlWorkflow: procedure
        .input(z.object({ workflowId: z.string().uuid() }))
        .mutation(({ input, ctx }) => appFor(ctx).hitl.advance(input.workflowId)),

    getChatMessages: procedure.query(({ ctx }) => appFor(ctx).chat.listMessages()),

    addChatMessage: procedure
        .input(
            z.object({
                id: z.string(),
                content: z.string(),
                sender: z.enum(["user", "assistant"]),
                timestamp: z.number(),
                fileMentions: z.array(z.string()).optional(),
            }),
        )
        .mutation(({ input, ctx }) => appFor(ctx).chat.appendMessage(input)),

    clearAgentMemory: procedure.mutation(({ ctx }) => appFor(ctx).chat.clearAgentMemory()),

    clearChatMessages: procedure.mutation(({ ctx }) => appFor(ctx).chat.clearChatMessages()),
};
