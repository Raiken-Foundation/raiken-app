import { describe, expect, it } from "vitest";
import {
    createServerSession,
    isAllowedDashboardOrigin,
    isSessionAuthorized,
    redactRequestUrl,
} from "../server-auth";

describe("server session auth", () => {
    it("uses a loopback-only server without a credential by default", () => {
        const session = createServerSession(false);
        expect(session).toEqual({ mode: "loopback", host: "127.0.0.1" });
        expect(isSessionAuthorized({ host: "localhost:7101" }, session)).toBe(true);
        expect(isSessionAuthorized({ host: "attacker.test:7101" }, session)).toBe(false);
        expect(
            isSessionAuthorized(
                { host: "localhost:7101", origin: "https://attacker.test" },
                session,
            ),
        ).toBe(false);
        expect(isSessionAuthorized({}, session)).toBe(false);
    });

    it("requires the generated bearer token in remote mode", () => {
        const session = createServerSession(true);
        expect(session.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(isSessionAuthorized({}, session)).toBe(false);
        expect(isSessionAuthorized({ authorization: "Bearer wrong" }, session)).toBe(false);
        expect(isSessionAuthorized({ authorization: `Bearer ${session.token}` }, session)).toBe(
            true,
        );
    });

    it("redacts accidental credentials from loggable URLs", () => {
        expect(redactRequestUrl("/api/x?token=top-secret&safe=value")).toBe(
            "/api/x?token=%5BREDACTED%5D&safe=value",
        );
    });

    it("allows only same-host and known development dashboard origins", () => {
        expect(isAllowedDashboardOrigin("http://example.test:7101", "example.test:7101")).toBe(
            true,
        );
        expect(isAllowedDashboardOrigin("http://localhost:4200", "example.test:7101")).toBe(true);
        expect(isAllowedDashboardOrigin("https://attacker.test", "example.test:7101")).toBe(false);
    });
});

describe("HTTP session enforcement", () => {
    it("blocks rebinding and cross-origin requests before session bootstrap", async () => {
        const { default: fastify } = await import("fastify");
        const { registerServerSessionAuth } = await import("../server-auth");
        const app = fastify();
        const session = createServerSession(true);
        registerServerSessionAuth(app, session);
        app.get("/api/session", async () => ({ token: session.token }));
        app.get("/api/session-extra", async () => ({ private: true }));
        try {
            const rebound = await app.inject({
                url: "/api/session",
                headers: { host: "attacker.test", origin: "http://attacker.test" },
                remoteAddress: "127.0.0.1",
            });
            expect(rebound.statusCode).toBe(401);
            expect(rebound.json()).not.toHaveProperty("token");
            expect(
                (
                    await app.inject({
                        url: "/api/session",
                        headers: { host: "localhost:7101", origin: "https://attacker.test" },
                    })
                ).statusCode,
            ).toBe(403);
            expect(
                (
                    await app.inject({
                        url: "/api/session",
                        headers: { host: "localhost:7101" },
                        remoteAddress: "127.0.0.1",
                    })
                ).statusCode,
            ).toBe(200);
            expect(
                (
                    await app.inject({
                        url: "/api/session-extra",
                        headers: { host: "localhost:7101" },
                        remoteAddress: "127.0.0.1",
                    })
                ).statusCode,
            ).toBe(401);
            expect(
                (
                    await app.inject({
                        url: "/api/session",
                        headers: { host: "localhost:7101" },
                        remoteAddress: "192.168.1.20",
                    })
                ).statusCode,
            ).toBe(401);
        } finally {
            await app.close();
        }
    });
});
