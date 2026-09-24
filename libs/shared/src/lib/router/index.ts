import { chatHitlRouter } from "./chat-hitl";
import { configRouter } from "./config";
import { contractRouter } from "./contract";
import { discoveryRouter } from "./discovery";
import { indexingRouter } from "./indexing";
import { qualitySupportRouter } from "./quality-support";
import { testingRouter } from "./testing";
import { t } from "./trpc";

/** Composed tRPC router — procedure names and shapes are the public contract. */
export const appRouter = t.router({
    ...configRouter,
    ...contractRouter,
    ...chatHitlRouter,
    ...indexingRouter,
    ...testingRouter,
    ...discoveryRouter,
    ...qualitySupportRouter,
});

export type AppRouter = typeof appRouter;

export type { Context } from "./trpc";
