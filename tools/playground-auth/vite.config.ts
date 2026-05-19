import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ---------------------------------------------------------------------------
// Auth middleware — simulates NextAuth's middleware.ts running at the Edge.
//
// Every request that doesn't belong to a public path and doesn't carry a valid
// session cookie is answered with a bare 302 → /auth/login, before any HTML
// or JS is served.  This is the pattern that makes `raiken discover` produce
// "0 pages found" rather than an auth-blocker handoff.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "raiken-session";
// Paths that bypass the auth check regardless of session state.
// This mirrors how NextAuth's middleware skips static files and its own
// endpoints while protecting all page routes.
const PUBLIC_PREFIXES = [
    "/auth/",       // auth pages and callbacks
    "/@",           // Vite internals (/@vite/client, /@fs/…)
    "/node_modules",
    "/__vite",
];

function parseCookies(header = ""): Record<string, string> {
    return Object.fromEntries(
        header
            .split(";")
            .map((c) => c.trim().split("="))
            .filter(([k]) => k)
            .map(([k, ...v]) => [k.trim(), v.join("=").trim()]),
    );
}

function isPublic(pathname: string): boolean {
    // Vite's own prefixes and auth endpoints are always public.
    if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return true;

    // Any URL with a file extension is a static asset or source module —
    // let it through so Vite can serve JS/CSS/images without a session.
    // Real NextAuth middleware does the same: it intercepts page routes only.
    const lastSegment = pathname.split("/").pop() ?? "";
    if (lastSegment.includes(".")) return true;

    return false;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
    });
}

function makeSessionCookie(username: string): string {
    const payload = Buffer.from(
        JSON.stringify({ user: username, exp: Date.now() + 86_400_000 }),
    ).toString("base64");
    return `${SESSION_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax`;
}

export default defineConfig({
    plugins: [
        react(),
        {
            name: "nextauth-middleware-sim",
            configureServer(server) {
                // ── Login POST handler ────────────────────────────────────────────
                server.middlewares.use(
                    "/auth/callback/credentials",
                    async (req: IncomingMessage, res: ServerResponse, next) => {
                        if (req.method !== "POST") return next();

                        const body = await readBody(req);
                        const params = new URLSearchParams(body);
                        const username =
                            params.get("username") ||
                            (params.get("email") ?? "").split("@")[0] ||
                            "user";

                        // Accept any credentials — this is a demo fixture.
                        res.writeHead(302, {
                            "Set-Cookie": makeSessionCookie(username),
                            Location: "/dashboard",
                        });
                        res.end();
                    },
                );

                // ── Logout handler ────────────────────────────────────────────────
                server.middlewares.use(
                    "/auth/signout",
                    (_req: IncomingMessage, res: ServerResponse) => {
                        res.writeHead(302, {
                            "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
                            Location: "/auth/login",
                        });
                        res.end();
                    },
                );

                // ── NextAuth middleware simulation ─────────────────────────────────
                // Must be registered AFTER the public endpoint handlers above.
                server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
                    const url = new URL(req.url ?? "/", "http://localhost");

                    if (isPublic(url.pathname)) return next();

                    const cookies = parseCookies(req.headers.cookie);
                    if (cookies[SESSION_COOKIE]) return next();

                    // No session → same response as NextAuth middleware.ts
                    res.writeHead(302, { Location: "/auth/login" });
                    res.end();
                });
            },
        },
    ],
    server: {
        port: 5100,
        // Listen on all interfaces so both 127.0.0.1 and ::1 are reachable.
        // This is required for the test harness's TCP port probe to work on
        // macOS where Node.js resolves "localhost" to ::1 by default.
        host: "0.0.0.0",
    },
});
