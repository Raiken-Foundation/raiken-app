import { getDiscoveryDefaults, MAX_DISCOVERY_EVENTS } from "@raiken/core";
import { z } from "zod";
import { resolveAuthStorageStateDestination } from "../config-server";
import { appFor, resolveProjectPath } from "./app-context";
import { procedure } from "./trpc";

export const discoveryRouter = {
    startDiscovery: procedure
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url(),
                maxPages: z.number().int().positive().optional(),
                maxDepth: z.number().int().positive().optional(),
                timeout: z.number().int().positive().optional(),
                skipAuth: z.boolean().default(false),
                excludePatterns: z.array(z.string()).optional(),
            }),
        )
        .mutation(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.start({
                url: input.url,
                maxPages: input.maxPages,
                maxDepth: input.maxDepth,
                timeout: input.timeout,
                skipAuth: input.skipAuth,
                excludePatterns: input.excludePatterns,
            });
        }),

    continueDiscovery: procedure
        .input(
            z.object({
                path: z.string().optional(),
                skipAuth: z.boolean().default(false),
                resolution: z
                    .enum(["clear", "skip", "ignore_category", "provide_state"])
                    .default("clear"),
                blockerId: z.number().int().positive().optional(),
                category: z
                    .enum([
                        "auth_required",
                        "captcha",
                        "consent_wall",
                        "rate_limited",
                        "geo_blocked",
                        "interstitial",
                        "error_page",
                        "manual",
                        "unknown",
                    ])
                    .optional(),
                storageStatePath: z.string().optional(),
            }),
        )
        .mutation(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.continue(input);
        }),

    getDiscoveryRuntime: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(async ({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.hydrateRuntime();
        }),

    getDiscoveryDefaults: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(async ({ input, ctx }) => getDiscoveryDefaults(resolveProjectPath(ctx, input.path))),

    getDiscoveryTimeline: procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().int().positive().max(MAX_DISCOVERY_EVENTS).default(50),
            }),
        )
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getTimeline(input.limit);
        }),

    authAssist: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getAuthAssist();
        }),

    getDiscoveryStats: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            const stats = appFor({ projectPath }).discovery.getStats();
            return { ...stats, timestamp: new Date().toISOString() };
        }),

    getDiscoverySession: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getSessionView();
        }),

    getDiscoveredPages: procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(50),
                offset: z.number().default(0),
            }),
        )
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.listDiscoveredPages({
                limit: input.limit,
                offset: input.offset,
            });
        }),

    getVerifiedLinks: procedure
        .input(
            z.object({
                path: z.string().optional(),
                limit: z.number().default(100),
            }),
        )
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getVerifiedLinks(input.limit);
        }),

    getDiscoveredPageSnapshot: procedure
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url(),
            }),
        )
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getDiscoveredPageSnapshot(input.url);
        }),

    getAuthBlockers: procedure
        .input(z.object({ path: z.string().optional() }))
        .query(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.getAuthBlockers();
        }),

    clearDiscoveryData: procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.clearData();
        }),

    pauseDiscovery: procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.pause();
        }),

    requestBrowserHandoff: procedure
        .input(
            z.object({
                path: z.string().optional(),
                url: z.string().url().optional(),
                blockerId: z.number().int().positive().optional(),
                category: z
                    .enum([
                        "auth_required",
                        "captcha",
                        "consent_wall",
                        "rate_limited",
                        "geo_blocked",
                        "interstitial",
                        "error_page",
                        "manual",
                        "unknown",
                    ])
                    .optional(),
                timeoutMs: z
                    .number()
                    .int()
                    .positive()
                    .max(30 * 60 * 1000)
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.requestBrowserHandoff(
                input,
                resolveAuthStorageStateDestination,
            );
        }),

    cancelBrowserHandoff: procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.cancelBrowserHandoff();
        }),

    abortDiscovery: procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(async ({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.abort();
        }),

    dismissDiscoveryError: procedure
        .input(z.object({ path: z.string().optional() }))
        .mutation(({ input, ctx }) => {
            const projectPath = resolveProjectPath(ctx, input.path);
            return appFor({ projectPath }).discovery.dismissError();
        }),
};
