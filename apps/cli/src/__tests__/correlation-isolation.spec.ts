import * as crypto from "node:crypto";
import { correlationFields } from "@raiken/core";
import { procedure, t } from "@raiken/shared/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerCorrelationScope } from "../server-correlation";

const testRouter = t.router({
    correlationEcho: procedure.query(({ ctx }) => ({
        headerId: ctx.correlationId,
        alsId: correlationFields().correlationId,
        requestId: ctx.requestId,
    })),
});

describe("request correlation isolation", () => {
    let app: ReturnType<typeof fastify>;

    afterEach(async () => {
        if (app) await app.close();
    });

    async function createApp() {
        const server = fastify({
            genReqId: () => crypto.randomBytes(8).toString("hex"),
            requestIdHeader: "x-request-id",
        });
        const projectPath = process.cwd();
        registerCorrelationScope(server, projectPath);

        server.get("/api/echo-correlation", async (request) => {
            const fields = correlationFields();
            return {
                correlationId: fields.correlationId,
                requestId: request.id,
            };
        });

        await server.register(fastifyTRPCPlugin, {
            prefix: "/api/trpc",
            trpcOptions: {
                router: testRouter,
                createContext: ({ req }) => ({
                    projectPath,
                    correlationId:
                        typeof req.headers["x-correlation-id"] === "string"
                            ? req.headers["x-correlation-id"]
                            : undefined,
                    requestId: req.id,
                }),
            },
        });

        await server.ready();
        return server;
    }

    it("keeps distinct correlation ids for parallel Fastify routes", async () => {
        app = await createApp();
        const [left, right] = await Promise.all([
            app.inject({
                method: "GET",
                url: "/api/echo-correlation",
                headers: { "x-correlation-id": "corr-left" },
            }),
            app.inject({
                method: "GET",
                url: "/api/echo-correlation",
                headers: { "x-correlation-id": "corr-right" },
            }),
        ]);

        const leftBody = left.json<{ correlationId: string }>();
        const rightBody = right.json<{ correlationId: string }>();
        expect(leftBody.correlationId).toBe("corr-left");
        expect(rightBody.correlationId).toBe("corr-right");
        expect(leftBody.requestId).not.toBe(rightBody.requestId);
    });

    it("keeps distinct correlation ids for parallel tRPC procedures", async () => {
        app = await createApp();
        const [left, right] = await Promise.all([
            app.inject({
                method: "GET",
                url: "/api/trpc/correlationEcho",
                headers: { "x-correlation-id": "trpc-a" },
            }),
            app.inject({
                method: "GET",
                url: "/api/trpc/correlationEcho",
                headers: { "x-correlation-id": "trpc-b" },
            }),
        ]);

        expect(left.statusCode).toBe(200);
        expect(right.statusCode).toBe(200);
        const leftBody = left.json<{ result: { data: { headerId: string; alsId: string } } }>();
        const rightBody = right.json<{ result: { data: { headerId: string; alsId: string } } }>();
        expect(leftBody.result.data.headerId).toBe("trpc-a");
        expect(leftBody.result.data.alsId).toBe("trpc-a");
        expect(rightBody.result.data.headerId).toBe("trpc-b");
        expect(rightBody.result.data.alsId).toBe("trpc-b");
    });
});
