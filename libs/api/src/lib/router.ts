// libs/api/src/lib/router.ts
import { initTRPC } from "@trpc/server";
// import { z } from "zod";

// Define context type
interface Context {
    projectPath: string;
}

const t = initTRPC.context<Context>().create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return { 
            status: "ok", 
            engine: "raiken",
            version: "0.0.1"
        };
    }),

    getProjectInfo: t.procedure.query(async ({ ctx }) => {
        return {
            path: ctx.projectPath,
            nodeVersion: process.version,
            timestamp: new Date().toISOString()
        };
    }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
