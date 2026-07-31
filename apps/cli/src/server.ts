import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
    BrowserSession,
    correlationFields,
    disposeAllProjectApplications,
    humanizeToolCall,
    type OrchestratorResult,
    obs,
    PathContainmentError,
    ProjectArtifactService,
    ProjectContext,
    runOrchestrator,
    serializeSafeClientError,
    serializeSafeHttpErrorBody,
    type ToolResult,
} from "@raiken/core";
import { appRouter } from "@raiken/shared/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { bootstrapProject } from "./bootstrap";
import { CLI_EXIT } from "./errors";
import { detectProject } from "./project-detector";
import {
    createServerSession,
    isAllowedDashboardOrigin,
    isLoopbackAddress,
    isSessionAuthorized,
    redactRequestUrl,
} from "./server-auth";
import { registerCorrelationScope } from "./server-correlation";

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
    // queries (commonly 8-15 procedures) resolve correctly. (Lives under
    // `routerOptions` — top-level router options are deprecated, FSTDEP022.)
    const app = fastify({
        genReqId: () => crypto.randomBytes(8).toString("hex"),
        requestIdHeader: "x-request-id",
        logger: {
            // "warn": `raiken start` prints its own startup line; info-level
            // pino JSON (listen banner, per-request logs) is noise on a CLI.
            // Handler request.log.error(...) calls still surface.
            level: "warn",
            serializers: {
                req(request) {
                    return {
                        method: request.method,
                        url: redactRequestUrl(request.url),
                        requestId: request.id,
                    };
                },
            },
        },
        routerOptions: {
            maxParamLength: 8192,
        },
    });
    const projectPath = process.cwd();
    const artifactService = new ProjectArtifactService(projectPath);

    registerCorrelationScope(app, projectPath);

    app.addHook("onRequest", async (request) => {
        (request.raw as { __raikenStartedAt?: number }).__raikenStartedAt = Date.now();
    });

    app.addHook("onResponse", async (request, reply) => {
        if (!request.url.startsWith("/api")) return;
        const startedAt =
            (request.raw as { __raikenStartedAt?: number }).__raikenStartedAt ?? Date.now();
        const correlation = request.raikenCorrelation ?? correlationFields();
        obs.duration("http.request.completed", startedAt, {
            level: reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info",
            status: reply.statusCode,
            message: `${request.method} ${redactRequestUrl(request.url)}`,
            requestId: request.id,
            correlationId: correlation.correlationId,
            operationId: correlation.operationId,
        });
    });

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
            createContext: ({ req }) => ({
                projectPath,
                correlationId:
                    (typeof req.headers["x-correlation-id"] === "string" &&
                        req.headers["x-correlation-id"]) ||
                    undefined,
                requestId: req.id,
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
            const body = serializeSafeHttpErrorBody(error);
            const status = error instanceof PathContainmentError ? 403 : 400;
            return reply.code(status).send(body);
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
            reply.code(500).send(serializeSafeHttpErrorBody(err));
        }
    });

    // AI Test Generation — Server-Sent Events (SSE) transport adapter.
    //
    // Orchestration runs through `runOrchestrator` (same agent graph as the CLI
    // REPL). This route is intentionally NOT migrated to tRPC: SSE streaming
    // semantics stay on a dedicated HTTP endpoint until a unified transport
    // migration is scoped separately from the application seam.
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

            const agentStartedAt = Date.now();
            try {
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
                let agentResult: OrchestratorResult | undefined;

                while (true) {
                    const { value, done } = await stream.next();
                    if (done) {
                        agentResult = value;
                        break;
                    }
                    if (clientGone) break;
                    hasData = true;
                    if (!reply.raw.writableEnded) {
                        reply.raw.write(`data: ${JSON.stringify({ chunk: value })}\n\n`);
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

                finished = true;
                const correlation = correlationFields();
                if (agentResult?.workflowId) {
                    correlation.workflowId = agentResult.workflowId;
                }
                obs.duration("agent.handoff.completed", agentStartedAt, {
                    status: "completed",
                    workflowId: agentResult?.workflowId,
                    runId: correlation.runId,
                });
                reply.raw.write(
                    `data: ${JSON.stringify({
                        done: true,
                        workflowId: agentResult?.workflowId,
                        correlationId: correlation.correlationId,
                        runId: correlation.runId,
                        operationId: correlation.operationId,
                    })}\n\n`,
                );
                reply.raw.end();
            } catch (error) {
                const safe = serializeSafeClientError(error);
                console.error("Stream error:", safe.message);
                if (!clientGone && !reply.raw.writableEnded) {
                    finished = true;
                    reply.raw.write(
                        `data: ${JSON.stringify({
                            error: {
                                message: safe.message,
                                raikenCode: safe.code,
                                retryable: safe.retryable,
                                correlationId: safe.correlationId,
                                operationId: safe.operationId,
                            },
                        })}\n\n`,
                    );
                    reply.raw.end();
                }
            } finally {
                reply.raw.off("close", onClientClose);
            }
        } catch (err) {
            const body = serializeSafeHttpErrorBody(err);
            request.log?.error?.({ err: body.error, raikenCode: body.raiken.code });
            reply.code(500).send(body);
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
            console.warn("Error closing HTTP server:", serializeSafeClientError(err).message);
        }
        try {
            ProjectContext.getInstance(projectPath).stopWatching();
        } catch {
            /* watcher not active */
        }
        try {
            await disposeAllProjectApplications();
        } catch (err) {
            console.warn(
                "Error disposing application services:",
                serializeSafeClientError(err).message,
            );
        }
        try {
            await BrowserSession.closeInstance();
        } catch (err) {
            console.warn("Error closing browser:", serializeSafeClientError(err).message);
        }
        process.exit(exitCode);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    // A rejected promise or thrown error deep in an async handler must not
    // silently take the whole server down. Log rejections and keep serving;
    // an uncaught exception is unrecoverable, so shut down cleanly.
    process.on("unhandledRejection", (reason) => {
        console.error(
            "Unhandled promise rejection (continuing):",
            serializeSafeClientError(reason).message,
        );
    });
    process.on("uncaughtException", (err) => {
        console.error("Uncaught exception:", serializeSafeClientError(err).message);
        void shutdown("uncaughtException", CLI_EXIT.RUNTIME_FAILURE);
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
        const code = (err as { code?: string }).code;
        if (code === "EADDRINUSE") {
            // Typical cause: a previous `raiken start` (or its orphaned
            // server) still holds the port. Name that, not a pino stack.
            console.error(
                `\n  Port ${port} is already in use — is another \`raiken start\` still running?` +
                    `\n  Stop it (or run \`lsof -i :${port}\` to find the process), ` +
                    `or use \`raiken start --port ${port + 1}\`.`,
            );
        } else {
            console.error(
                `\n  Could not start the dashboard server: ${serializeSafeClientError(err).message}`,
            );
        }
        process.exit(CLI_EXIT.RUNTIME_FAILURE);
    }
}
