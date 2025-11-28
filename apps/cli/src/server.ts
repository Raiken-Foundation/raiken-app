import path from "node:path";
import fastifyStatic from "@fastify/static";
import { appRouter } from "@raiken/api";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify"; // You need to install this!
import fastify from "fastify";

export async function startServer(port = 7101) {
    const app = fastify({ logger: true });

    await app.register(fastifyTRPCPlugin, {
        prefix: "/trpc",
        trpcOptions: { router: appRouter },
    });

    // This matches the 'assets' output in project.json
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
