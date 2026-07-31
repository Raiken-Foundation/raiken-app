import { assertUnderProjectRoot, getProjectApplication } from "@raiken/core";
import type { Context } from "./trpc";

/** Resolve cached project-scoped application services from tRPC context. */
export function appFor(ctx: Context) {
    return getProjectApplication(ctx.projectPath);
}

/**
 * Optional explicit path override used by several discovery/indexing procedures.
 *
 * The override is a client-supplied string, so it is contained beneath the
 * server's project root: a request may address a subdirectory of the project
 * the server was started in, never another project on the machine.
 */
export function resolveProjectPath(ctx: Context, pathOverride?: string): string {
    if (!pathOverride) return ctx.projectPath;
    return assertUnderProjectRoot(pathOverride, ctx.projectPath);
}
