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
        expect(isSessionAuthorized({}, session)).toBe(true);
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
