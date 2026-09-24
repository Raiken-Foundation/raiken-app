import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface ServerSession {
    mode: "loopback" | "remote";
    host: "127.0.0.1" | "0.0.0.0";
    token?: string;
}

type ServerHeaders = Record<string, string | string[] | undefined> & {
    authorization?: string | string[];
    "x-raiken-token"?: string | string[];
};

export function createServerSession(remote: boolean): ServerSession {
    if (!remote) return { mode: "loopback", host: "127.0.0.1" };
    return {
        mode: "remote",
        host: "0.0.0.0",
        token: randomBytes(32).toString("base64url"),
    };
}

export function getSessionToken(headers: ServerHeaders): string {
    const authorization = headers.authorization;
    const bearer =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : undefined;
    const headerToken = headers["x-raiken-token"];
    const direct = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    return bearer ?? direct ?? "";
}

export function isSessionAuthorized(headers: ServerHeaders, session: ServerSession): boolean {
    if (session.mode === "loopback") {
        const host = typeof headers.host === "string" ? headers.host : undefined;
        const origin = typeof headers.origin === "string" ? headers.origin : undefined;
        return isLocalHost(host) && isAllowedDashboardOrigin(origin, host);
    }
    const supplied = getSessionToken(headers);
    if (!session.token || supplied.length !== session.token.length) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(session.token);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopbackAddress(address: string | undefined): boolean {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Remove credentials from request URLs before Fastify logs them. Tokens should
 * be transmitted in headers, but redacting common query names makes an
 * accidental URL-based credential less damaging.
 */
export function redactRequestUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl, "http://raiken.local");
        for (const key of url.searchParams.keys()) {
            if (/token|key|authorization|secret/i.test(key))
                url.searchParams.set(key, "[REDACTED]");
        }
        return `${url.pathname}${url.search}`;
    } catch {
        return rawUrl.replace(/([?&](?:token|key|authorization|secret)=)[^&\s]+/gi, "$1[REDACTED]");
    }
}

export function isLocalHost(host: string | undefined): boolean {
    if (!host || /[\\/@?#\s]/.test(host)) return false;
    try {
        const hostname = new URL(`http://${host}`).hostname;
        return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    } catch {
        return false;
    }
}

export function isAllowedDashboardOrigin(
    origin: string | undefined,
    host: string | undefined,
): boolean {
    if (!origin) return true;
    try {
        const source = new URL(origin);
        if (!["http:", "https:"].includes(source.protocol) || source.username || source.password)
            return false;
        if (source.host === host) return true;
        return (
            (source.protocol === "http:" || source.protocol === "https:") &&
            (source.hostname === "localhost" || source.hostname === "127.0.0.1") &&
            source.port === "4200"
        );
    } catch {
        return false;
    }
}

/** Shared HTTP enforcement for API, SSE and artifact routes. */
export function registerServerSessionAuth(app: FastifyInstance, session: ServerSession): void {
    app.addHook("onRequest", async (request, reply) => {
        if (!request.url.startsWith("/api")) return;

        if (!isAllowedDashboardOrigin(request.headers.origin, request.headers.host)) {
            return reply.code(403).send({ error: "origin not allowed" });
        }

        // A local operator can inspect the current session if a future
        // development client needs to bootstrap it. Never expose a remote
        // token to a LAN requester.
        if (
            session.mode === "remote" &&
            request.url.split("?")[0] === "/api/session" &&
            isLoopbackAddress(request.ip) &&
            isLocalHost(request.headers.host)
        )
            return;

        if (!isSessionAuthorized(request.headers, session)) {
            return reply.code(401).send({ error: "authorization required" });
        }
    });
}
