import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchServerArtifact, getServerSessionToken, serverAuthHeaders } from "../api-auth";

afterEach(() => {
    document.querySelector('meta[name="raiken-session-token"]')?.remove();
    sessionStorage.clear();
    vi.restoreAllMocks();
});

describe("dashboard server auth helper", () => {
    it("attaches the session token injected by the server", () => {
        const meta = document.createElement("meta");
        meta.name = "raiken-session-token";
        meta.content = "test-token";
        document.head.append(meta);

        expect(getServerSessionToken()).toBe("test-token");
        expect(serverAuthHeaders({ "Content-Type": "application/json" })).toEqual({
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
        });
    });

    it("does not add authorization in normal loopback mode", () => {
        expect(serverAuthHeaders()).toEqual({});
    });

    it("fetches artifacts with remote session authorization", async () => {
        const meta = document.createElement("meta");
        meta.name = "raiken-session-token";
        meta.content = "remote-token";
        document.head.append(meta);
        const artifact = new Blob(["artifact"]);
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            status: 200,
            blob: async () => artifact,
        } as Response);

        const result = await fetchServerArtifact("test-results/trace.zip");
        expect(result).toBe(artifact);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/artifact?path=test-results%2Ftrace.zip",
            expect.objectContaining({
                headers: { Authorization: "Bearer remote-token" },
            }),
        );
    });
});
