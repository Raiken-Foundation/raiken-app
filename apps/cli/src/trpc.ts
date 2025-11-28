// apps/cli/src/trpc.ts
import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const appRouter = t.router({
    // 1. Health Check
    getHealth: t.procedure.query(() => {
        return { status: "ok", engine: "raiken-trpc" };
    }),

    // 2. Project Info (The Sprint 1 Goal)
    getProjectInfo: t.procedure.query(() => {
        return {
            cwd: process.cwd(),
            nodeVersion: process.version,
        };
    }),

    // 3. Example Mutation (For future use)
    runScan: t.procedure.input(z.object({ path: z.string() })).mutation(({ input }) => {
        console.log(`Scanning ${input.path}...`);
        return { success: true, filesFound: 0 };
    }),
});

// Export the type definition of the API
// This is the MAGIC line that shares types with the frontend
export type AppRouter = typeof appRouter;
