import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { BrowserSession, ProjectContext, runOrchestrator } from "@raiken/core";
import { appRouter } from "@raiken/shared";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { bootstrapProject } from "./bootstrap";
import { detectProject } from "./project-detector";

export async function startServer(port = 7101) {
    // Fastify's default maxParamLength (100) truncates long tRPC batch
    // URLs like `/api/trpc/getA,getB,getC,...` and returns 404 before the
    // adapter sees the request. Bump it so realistic batches of dashboard
    // queries (commonly 8-15 procedures) resolve correctly.
    const app = fastify({ logger: true, maxParamLength: 8192 });
    const projectPath = process.cwd();

    // Initialize the code graph, ProjectContext, and AgentMemory. Shared with
    // `raiken chat` so both surfaces give the agent the same understanding.
    await bootstrapProject(projectPath);

    await app.register(fastifyTRPCPlugin, {
        prefix: "/api/trpc",
        trpcOptions: {
            router: appRouter,
            createContext: () => ({
                projectPath: process.cwd(),
            }),
        },
    });

    app.get("/api/artifact", async (request, reply) => {
        const { path: filePath } = request.query as { path?: string };
        if (!filePath) {
            return reply.code(400).send({ error: "path query parameter is required" });
        }
        const resolved = path.resolve(projectPath, filePath);
        if (
            !resolved.startsWith(path.resolve(projectPath) + path.sep) &&
            resolved !== path.resolve(projectPath)
        ) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (!fs.existsSync(resolved)) {
            return reply.code(404).send({ error: "artifact not found" });
        }
        return reply.sendFile(path.basename(resolved), path.dirname(resolved));
    });

    app.get("/api/project-info", async (request, reply) => {
        try {
            const info = await detectProject(process.cwd());
            return {
                name: info.name,
                cwd: info.rootDir,
                projectType: info.type,
                packageManager: info.packageManager,
                testDir: info.testDir,
                testFramework: info.testFramework,
            };
        } catch (err) {
            request.log?.error?.(err as Error);
            reply.code(500).send({ error: "failed to detect project", detail: String(err) });
        }
    });

    // AI Test Generation - Server-Sent Events (SSE) endpoint
    app.post("/api/generate-test", async (request, reply) => {
        try {
            const body = request.body as {
                prompt?: string;
                fileContext?: string[];
                conversationHistory?: Array<{ role: string; content: string }>;
                targetTestFile?: string;
            };
            const { prompt, conversationHistory, targetTestFile, fileContext } = body;

            if (!prompt) {
                reply.code(400).send({ error: "Prompt is required" });
                return;
            }

            // Set SSE headers
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.setHeader("Cache-Control", "no-cache");
            reply.raw.setHeader("Connection", "keep-alive");
            reply.raw.setHeader("Access-Control-Allow-Origin", "*");

            // Stop doing work if the client navigates away or closes the tab.
            //
            // IMPORTANT: listen on the RESPONSE stream (`reply.raw`), not the
            // request stream. For a POST, `request.raw` ("close") fires as soon
            // as the request BODY has been fully read — which is immediately —
            // and would spuriously abort the run in a few ms (and, before the
            // abort was wired, silently drop the result so the UI spun forever).
            // The response stream only closes when the client actually goes away
            // (or when we end it ourselves, guarded by `finished`).
            let clientGone = false;
            let finished = false;
            const abortController = new AbortController();
            const onClientClose = () => {
                if (finished) return; // our own reply.raw.end() also emits "close"
                clientGone = true;
                // Actually cancel the in-flight agent run (LangGraph honors the
                // signal at step boundaries) so we stop navigating pages and
                // calling the LLM the moment the user leaves.
                abortController.abort();
            };
            reply.raw.on("close", onClientClose);

            try {
                // Route through orchestrator (LLM decides what tools to call)
                const stream = runOrchestrator({
                    userPrompt: prompt,
                    projectPath: process.cwd(),
                    conversationHistory,
                    targetTestFile,
                    fileContext,
                    signal: abortController.signal,
                });

                let hasData = false;

                for await (const chunk of stream) {
                    if (clientGone) break;
                    hasData = true;

                    // Send chunk as SSE
                    if (!reply.raw.writableEnded) {
                        reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                    }
                }

                if (clientGone) {
                    if (!reply.raw.writableEnded) {
                        reply.raw.end();
                    }
                    return;
                }

                if (!hasData) {
                    console.warn("No data was streamed");
                    reply.raw.write(
                        `data: ${JSON.stringify({ error: "No response generated" })}\n\n`,
                    );
                }

                // Mark finished BEFORE ending so the "close" our own end() emits
                // isn't mistaken for a client disconnect.
                finished = true;
                // Send completion signal
                reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                reply.raw.end();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error("Stream error:", errorMessage);
                if (!clientGone && !reply.raw.writableEnded) {
                    finished = true;
                    reply.raw.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
                    reply.raw.end();
                }
            } finally {
                reply.raw.off("close", onClientClose);
            }
        } catch (err) {
            request.log?.error?.(err as Error);
            console.error("Request error:", err);
            reply.code(500).send({
                error: "Test generation failed",
                detail: String(err),
            });
        }
    });

    const publicDir = path.join(__dirname, "public");

    app.register(fastifyStatic, {
        root: publicDir,
        prefix: "/",
    });

    // SPA fallback: serve index.html for client-side routing
    app.setNotFoundHandler((request, reply) => {
        const isApiRoute = request.url.startsWith("/api");
        if (isApiRoute) {
            reply.code(404).send({ error: "Not found" });
        } else {
            // Serve index.html for client-side routing
            reply.sendFile("index.html");
        }
    });

    // Graceful shutdown: stop the HTTP server, the file watcher, and any live
    // Chromium browser so Ctrl+C / SIGTERM doesn't leave orphan processes or
    // half-written state. (AgentMemory and the site-DB cache register their own
    // once-handlers to close SQLite connections.)
    let shuttingDown = false;
    const shutdown = async (signal: string, exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\nReceived ${signal}, shutting down gracefully...`);
        try {
            await app.close();
        } catch (err) {
            console.warn("Error closing HTTP server:", err);
        }
        try {
            ProjectContext.getInstance(projectPath).stopWatching();
        } catch {
            /* watcher not active */
        }
        try {
            await BrowserSession.closeInstance();
        } catch (err) {
            console.warn("Error closing browser:", err);
        }
        process.exit(exitCode);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    // A rejected promise or thrown error deep in an async handler must not
    // silently take the whole server down. Log rejections and keep serving;
    // an uncaught exception is unrecoverable, so shut down cleanly.
    process.on("unhandledRejection", (reason) => {
        console.error("Unhandled promise rejection (continuing):", reason);
    });
    process.on("uncaughtException", (err) => {
        console.error("Uncaught exception:", err);
        void shutdown("uncaughtException", 1);
    });

    try {
        await app.listen({ port, host: "0.0.0.0" });
        console.log(`\nRaiken is running at http://localhost:${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
