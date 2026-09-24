import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configureAuthMiddleware } from "./auth-server";

export default defineConfig({
    plugins: [
        react(),
        {
            name: "nextauth-middleware-sim",
            configureServer(server) {
                configureAuthMiddleware(server.middlewares);
            },
        },
    ],
    server: {
        port: 5100,
        host: "0.0.0.0",
    },
});
