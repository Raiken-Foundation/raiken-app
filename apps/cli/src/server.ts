import path from "node:path";
import fastifyStatic from "@fastify/static";
import { appRouter } from "@raiken/api";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { detectProject } from "./project-detector";

export async function startServer(port = 7101) {
    const app = fastify({ logger: true });

    await app.register(fastifyTRPCPlugin, {
        prefix: "/api/trpc",
        trpcOptions: { 
            router: appRouter,
            createContext: () => ({
                projectPath: process.cwd()
            })
        },
    });

    app.get('/api/project-info', async (request, reply) => {
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
            reply.code(500).send({ error: 'failed to detect project', detail: String(err) });
        }
    });

    const publicDir = path.join(__dirname, "public");

    app.register(fastifyStatic, {
        root: publicDir,
        prefix: "/",
    });

    try {
        await app.listen({ port, host: "0.0.0.0" });
        console.log(`\n🚀 Raiken UI running at http://localhost:${port}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
