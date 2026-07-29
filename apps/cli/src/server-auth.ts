import { randomBytes, timingSafeEqual } from "node:crypto";

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
    if (session.mode === "loopback") return true;
    const supplied = getSessionToken(headers);
    if (!session.token || supplied.length !== session.token.length) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(session.token));
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

export function isAllowedDashboardOrigin(
    origin: string | undefined,
    host: string | undefined,
): boolean {
    if (!origin) return true;
    try {
        const source = new URL(origin);
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
