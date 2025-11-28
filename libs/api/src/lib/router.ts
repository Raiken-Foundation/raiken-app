// libs/api/src/lib/router.ts
import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const appRouter = t.router({
    getHealth: t.procedure.query(() => {
        return { status: "ok", engine: "raiken-lib" };
    }),

    getProjectInfo: t.procedure.query(() => {
        return {
            cwd: process.cwd(),
            nodeVersion: process.version,
        };
    }),
});

// Export the Type to be shared
export type AppRouter = typeof appRouter;
