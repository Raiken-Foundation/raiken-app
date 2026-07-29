import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
    BrowserSession,
    humanizeToolCall,
    PathContainmentError,
    ProjectArtifactService,
    ProjectContext,
    runOrchestrator,
    type ToolResult,
} from "@raiken/core";
import { appRouter } from "@raiken/shared";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { bootstrapProject } from "./bootstrap";
import { detectProject } from "./project-detector";
import {
    createServerSession,
    isAllowedDashboardOrigin,
    isLoopbackAddress,
    isSessionAuthorized,
    redactRequestUrl,
} from "./server-auth";

export interface StartServerOptions {
    port?: number;
    /** Bind on all interfaces and require a per-process bearer token. */
    remote?: boolean;
}

export async function startServer(options: StartServerOptions | number = 7101) {
    const port = typeof options === "number" ? options : (options.port ?? 7101);
    const session = createServerSession(
        typeof options === "number" ? false : options.remote === true,
    );
    // Fastify's default maxParamLength (100) truncates long tRPC batch
    // URLs like `/api/trpc/getA,getB,getC,...` and returns 404 before the
    // adapter sees the request. Bump it so realistic batches of dashboard
    // queries (commonly 8-15 procedures) resolve correctly.
    const app = fastify({
        logger: {
            level: "info",
            serializers: {
                req(request) {
                    return {
                        method: request.method,
                        url: redactRequestUrl(request.url),
                    };
                },
            },
        },
        maxParamLength: 8192,
    });
    const projectPath = process.cwd();
    const artifactService = new ProjectArtifactService(projectPath);

    // All API routes, including tRPC, artifacts, and the SSE endpoint, are
    // token-protected in explicitly enabled remote mode. Loopback mode relies
    // on its binding address and has no long-lived credential to manage.
    app.addHook("onRequest", async (request, reply) => {
        if (!request.url.startsWith("/api")) return;

        if (
            session.mode === "remote" &&
            !isAllowedDashboardOrigin(request.headers.origin, request.headers.host)
        ) {
            return reply.code(403).send({ error: "origin not allowed" });
        }

        // A local operator can inspect the current session if a future
        // development client needs to bootstrap it. Never expose a remote
        // token to a LAN requester.
        if (request.url.startsWith("/api/session") && isLoopbackAddress(request.ip)) return;

        if (!isSessionAuthorized(request.headers, session)) {
            return reply.code(401).send({ error: "authorization required" });
        }
    });

    // Initialize the code graph, ProjectContext, and AgentMemory. Shared with
    // `raiken chat` so both surfaces give the agent the same understanding.
    // A failure here degrades code understanding but must never take the
    // server down — other dashboard features (discovery, running existing
    // tests, settings) don't depend on it.
    const bootstrapResult = await bootstrapProject(projectPath);
    if (!bootstrapResult.ok) {
        console.error(
            "\n  ⚠ Project indexing failed to start — code search, impact analysis, and AI context " +
                "will be degraded until this is fixed. See the error above for details.\n",
        );
    } else if (bootstrapResult.warnings.length > 0) {
        console.warn(
            `\n  ⚠ Project indexing completed with ${bootstrapResult.warnings.length} warning(s) — some capabilities may be degraded.\n`,
        );
    }

    await app.register(fastifyTRPCPlugin, {
        prefix: "/api/trpc",
        trpcOptions: {
            router: appRouter,
            createContext: () => ({
                projectPath,
            }),
        },
    });

    app.get("/api/session", async (request, reply) => {
        if (!isLoopbackAddress(request.ip)) {
            return reply.code(403).send({ error: "loopback access required" });
        }
        return { mode: session.mode, token: session.token ?? null };
    });

    app.get("/api/artifact", async (request, reply) => {
        const { path: filePath } = request.query as { path?: string };
        if (!filePath) {
            return reply.code(400).send({ error: "path query parameter is required" });
        }
        let resolved: string;
        try {
            resolved = artifactService.resolve(filePath);
        } catch (error) {
            if (!(error instanceof PathContainmentError)) throw error;
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

            // Structured `{ type: "tool", ... }` SSE events, alongside (not
            // instead of) the humanized `<!--EVENT:...-->` markers already
            // embedded in the text stream — a richer signal for dashboard UI
            // that wants tool name/success/message without scraping text.
            // Guarded the same way as the `chunk`/`done` writes below since
            // these callbacks can fire after the client has disconnected.
            const writeToolEvent = (event: Record<string, unknown>) => {
                if (clientGone || reply.raw.writableEnded) return;
                reply.raw.write(`data: ${JSON.stringify({ type: "tool", ...event })}\n\n`);
            };

            try {
                // Route through orchestrator (LLM decides what tools to call)
                const stream = runOrchestrator({
                    userPrompt: prompt,
                    projectPath: process.cwd(),
                    conversationHistory,
                    targetTestFile,
                    fileContext,
                    signal: abortController.signal,
                    origin: "dashboard",
                    onToolCall: (toolName) => {
                        writeToolEvent({
                            phase: "call",
                            name: toolName,
                            label: humanizeToolCall(toolName),
                        });
                    },
                    onToolResult: (toolName, result: ToolResult) => {
                        writeToolEvent({
                            phase: "result",
                            name: toolName,
                            success: result?.success ?? true,
                            message: result?.message,
                        });
                    },
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
    const renderDashboardIndex = () => {
        const index = fs.readFileSync(path.join(publicDir, "index.html"), "utf-8");
        // Never inject the remote token into a static page: unauthenticated
        // LAN clients can fetch assets. A remote operator supplies it once via
        // `?raiken_token=…`, and the dashboard immediately stores and removes
        // it from the visible URL.
        return index.replace("<!--RAIKEN_AUTH_TOKEN-->", "");
    };

    app.get("/", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(renderDashboardIndex());
    });

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
            // Serve the SPA fallback with the in-memory remote session token.
            reply.type("text/html; charset=utf-8").send(renderDashboardIndex());
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
        await app.listen({ port, host: session.host });
        console.log(`\nRaiken is running at http://localhost:${port}`);
        if (session.mode === "remote") {
            console.warn(
                "Remote mode is enabled. Open the dashboard with " +
                    `?raiken_token=${session.token} once; API requests require this session token.\n`,
            );
        }
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
