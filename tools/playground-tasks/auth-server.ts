import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Connect } from "vite";
import {
    buildSessionPayload,
    findFixtureUser,
    MFA_CODE,
    MFA_PENDING_TTL_MS,
    REAUTH_PROOF_TTL_MS,
    type SessionPayload,
    validateCredentials,
} from "./src/auth/fixture.ts";

export const SESSION_COOKIE = "raiken-session";
export const MFA_PENDING_COOKIE = "raiken-mfa-pending";
export const REAUTH_PROOF_COOKIE = "raiken-reauth-proof";

const PUBLIC_PREFIXES = ["/auth/", "/@", "/node_modules", "/__vite"];

interface MfaPendingPayload {
    username: string;
    exp: number;
}

interface ReauthProofPayload {
    user: string;
    exp: number;
}

export function parseCookies(header = ""): Record<string, string> {
    return Object.fromEntries(
        header
            .split(";")
            .map((cookie) => cookie.trim().split("="))
            .filter(([key]) => key)
            .map(([key, ...value]) => [key.trim(), value.join("=").trim()]),
    );
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => resolve(body));
    });
}

function encodePayload(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodePayload<T>(encoded: string | undefined): T | null {
    if (!encoded) return null;
    try {
        return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
    } catch {
        return null;
    }
}

function clearCookie(name: string): string {
    return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function setCookie(name: string, value: string, maxAgeSeconds?: number): string {
    const maxAge = maxAgeSeconds ? `; Max-Age=${maxAgeSeconds}` : "";
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${maxAge}`;
}

function jsonResponse(
    res: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders?: OutgoingHttpHeaders,
) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}

function redirectResponse(res: ServerResponse, location: string, cookies: string[] = []) {
    res.writeHead(302, {
        Location: location,
        ...(cookies.length > 0 ? { "Set-Cookie": cookies } : {}),
    });
    res.end();
}

export function parseSession(cookies: Record<string, string>): SessionPayload | null {
    const payload = decodePayload<SessionPayload>(cookies[SESSION_COOKIE]);
    if (!payload?.user || !payload.exp) return null;
    if (Date.now() >= payload.exp) return null;
    return payload;
}

function parseMfaPending(cookies: Record<string, string>): MfaPendingPayload | null {
    const payload = decodePayload<MfaPendingPayload>(cookies[MFA_PENDING_COOKIE]);
    if (!payload?.username || !payload.exp) return null;
    if (Date.now() >= payload.exp) return null;
    return payload;
}

function parseReauthProof(cookies: Record<string, string>): ReauthProofPayload | null {
    const payload = decodePayload<ReauthProofPayload>(cookies[REAUTH_PROOF_COOKIE]);
    if (!payload?.user || !payload.exp) return null;
    if (Date.now() >= payload.exp) return null;
    return payload;
}

function makeSessionCookie(user: ReturnType<typeof findFixtureUser>): string {
    if (!user) throw new Error("Missing fixture user");
    return setCookie(SESSION_COOKIE, encodePayload(buildSessionPayload(user)));
}

function makeMfaPendingCookie(username: string): string {
    const payload: MfaPendingPayload = {
        username,
        exp: Date.now() + MFA_PENDING_TTL_MS,
    };
    return setCookie(MFA_PENDING_COOKIE, encodePayload(payload), MFA_PENDING_TTL_MS / 1000);
}

function makeReauthProofCookie(username: string): string {
    const payload: ReauthProofPayload = {
        user: username,
        exp: Date.now() + REAUTH_PROOF_TTL_MS,
    };
    return setCookie(REAUTH_PROOF_COOKIE, encodePayload(payload), REAUTH_PROOF_TTL_MS / 1000);
}

function isPublic(pathname: string): boolean {
    if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
    const lastSegment = pathname.split("/").pop() ?? "";
    return lastSegment.includes(".");
}

function isApiRoute(pathname: string): boolean {
    return pathname.startsWith("/api/");
}

function wantsJson(req: IncomingMessage): boolean {
    const accept = req.headers.accept ?? "";
    return accept.includes("application/json");
}

async function handleCredentialsCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const username = (params.get("username") ?? params.get("email") ?? "").trim();
    const password = params.get("password") ?? "";

    const result = validateCredentials(username, password);
    if (!result.ok) {
        const status = result.error === "locked" ? 403 : 401;
        jsonResponse(res, status, { error: result.error, message: result.message });
        return;
    }

    if (result.user.mfaRequired) {
        const cookies = [makeMfaPendingCookie(result.user.username)];
        if (wantsJson(req)) {
            jsonResponse(res, 200, { ok: true, redirect: "/auth/mfa" }, { "Set-Cookie": cookies });
            return;
        }
        redirectResponse(res, "/auth/mfa", cookies);
        return;
    }

    const cookies = [makeSessionCookie(result.user)];
    if (wantsJson(req)) {
        jsonResponse(res, 200, { ok: true, redirect: "/dashboard" }, { "Set-Cookie": cookies });
        return;
    }
    redirectResponse(res, "/dashboard", cookies);
}

async function handleMfaCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const pending = parseMfaPending(cookies);
    if (!pending) {
        jsonResponse(res, 401, {
            error: "mfa_expired",
            message: "MFA session expired. Sign in again.",
        });
        return;
    }

    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = (params.get("code") ?? "").trim();

    if (code !== MFA_CODE) {
        jsonResponse(res, 401, {
            error: "invalid_mfa",
            message: "Invalid verification code.",
        });
        return;
    }

    const user = findFixtureUser(pending.username);
    if (!user) {
        jsonResponse(res, 401, {
            error: "invalid_mfa",
            message: "Invalid verification code.",
        });
        return;
    }

    const sessionCookies = [makeSessionCookie(user), clearCookie(MFA_PENDING_COOKIE)];
    if (wantsJson(req)) {
        jsonResponse(
            res,
            200,
            { ok: true, redirect: "/dashboard" },
            { "Set-Cookie": sessionCookies },
        );
        return;
    }
    redirectResponse(res, "/dashboard", sessionCookies);
}

async function handleReauth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const session = parseSession(cookies);
    if (!session) {
        jsonResponse(res, 401, { error: "unauthenticated", message: "Sign in required." });
        return;
    }

    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const password = params.get("password") ?? "";
    const user = findFixtureUser(session.user);

    if (!user || user.password !== password) {
        jsonResponse(res, 401, {
            error: "invalid_password",
            message: "Incorrect password.",
        });
        return;
    }

    jsonResponse(res, 200, { ok: true }, { "Set-Cookie": makeReauthProofCookie(session.user) });
}

async function handleWorkspaceDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const session = parseSession(cookies);
    if (!session) {
        jsonResponse(res, 401, { error: "unauthenticated", message: "Sign in required." });
        return;
    }

    if (session.role !== "admin" || !session.permissions.includes("manage:workspace")) {
        jsonResponse(res, 403, {
            error: "forbidden",
            message: "Admin permission required to delete the workspace.",
        });
        return;
    }

    const proof = parseReauthProof(cookies);
    if (!proof || proof.user !== session.user) {
        jsonResponse(res, 401, {
            error: "reauth_required",
            message: "Recent password confirmation required.",
        });
        return;
    }

    jsonResponse(res, 200, {
        ok: true,
        deleted: true,
        message: "Workspace deletion simulated successfully.",
    });
}

function handleSession(req: IncomingMessage, res: ServerResponse): void {
    const cookies = parseCookies(req.headers.cookie);
    const encoded = cookies[SESSION_COOKIE];
    const payload = decodePayload<SessionPayload>(encoded);

    if (!payload?.user) {
        jsonResponse(res, 401, { error: "unauthenticated", message: "No active session." });
        return;
    }

    if (Date.now() >= payload.exp) {
        jsonResponse(
            res,
            401,
            {
                error: "session_expired",
                message: "Session expired.",
            },
            { "Set-Cookie": clearCookie(SESSION_COOKIE) },
        );
        return;
    }

    jsonResponse(res, 200, {
        user: payload.user,
        name: payload.name,
        role: payload.role,
        permissions: payload.permissions,
        exp: payload.exp,
    });
}

function handleSignout(_req: IncomingMessage, res: ServerResponse): void {
    redirectResponse(res, "/auth/login", [
        clearCookie(SESSION_COOKIE),
        clearCookie(MFA_PENDING_COOKIE),
        clearCookie(REAUTH_PROOF_COOKIE),
    ]);
}

function handleProtectedRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    next: Connect.NextFunction,
): void {
    const cookies = parseCookies(req.headers.cookie);
    const encoded = cookies[SESSION_COOKIE];
    const payload = decodePayload<SessionPayload>(encoded);
    const apiRoute = isApiRoute(pathname);

    if (!encoded || !payload?.user) {
        if (apiRoute || wantsJson(req)) {
            jsonResponse(res, 401, { error: "unauthenticated", message: "Sign in required." });
            return;
        }
        redirectResponse(res, "/auth/login");
        return;
    }

    if (Date.now() >= payload.exp) {
        if (apiRoute || wantsJson(req)) {
            jsonResponse(
                res,
                401,
                { error: "session_expired", message: "Session expired." },
                { "Set-Cookie": clearCookie(SESSION_COOKIE) },
            );
            return;
        }
        redirectResponse(res, "/auth/login?reason=expired", [clearCookie(SESSION_COOKIE)]);
        return;
    }

    next();
}

export function configureAuthMiddleware(server: Connect.Server): void {
    server.use("/auth/callback/credentials", async (req, res, next) => {
        if (req.method !== "POST") return next();
        await handleCredentialsCallback(req, res);
    });

    server.use("/auth/callback/mfa", async (req, res, next) => {
        if (req.method !== "POST") return next();
        await handleMfaCallback(req, res);
    });

    server.use("/auth/reauth", async (req, res, next) => {
        if (req.method !== "POST") return next();
        await handleReauth(req, res);
    });

    server.use("/api/workspace/delete", async (req, res, next) => {
        if (req.method !== "POST") return next();
        await handleWorkspaceDelete(req, res);
    });

    server.use("/auth/signout", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") return next();
        handleSignout(req, res);
    });

    server.use("/auth/session", (req, res, next) => {
        if (req.method !== "GET") return next();
        handleSession(req, res);
    });

    server.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (isPublic(url.pathname)) return next();
        handleProtectedRequest(req, res, url.pathname, next);
    });
}
