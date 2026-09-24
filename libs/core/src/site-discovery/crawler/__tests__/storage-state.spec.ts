import { describe, expect, it } from "vitest";
import { sanitizeStorageState } from "../storage-state";

/**
 * Pins the cookie-shape sanitizer contract (review finding,
 * storage-state.ts:31-41): every cookie the sanitizer emits must clear the
 * asserts playwright-core applies at context creation — url-or-domain,
 * domain→default path, expires ≥ -1 — and sameSite None must be secure
 * (Chromium silently drops None-without-secure).
 */

describe("sanitizeStorageState", () => {
    it("drops cookies with neither url nor domain", () => {
        const state = sanitizeStorageState({
            cookies: [
                { name: "session", value: "abc" },
                { name: "ok", value: "1", url: "https://app.example" },
            ],
        });
        expect(state.cookies).toHaveLength(1);
        expect(state.cookies[0]).toMatchObject({ name: "ok", url: "https://app.example" });
    });

    it("defaults path to / for domain cookies", () => {
        const state = sanitizeStorageState({
            cookies: [{ name: "session", value: "abc", domain: "app.example" }],
        });
        expect(state.cookies[0]).toMatchObject({ domain: "app.example", path: "/" });
    });

    it("clamps negative expires to -1 (session cookie)", () => {
        const state = sanitizeStorageState({
            cookies: [
                { name: "a", value: "1", domain: "app.example", expires: -5 },
                { name: "b", value: "2", domain: "app.example", expires: 12345 },
            ],
        });
        expect(state.cookies[0]?.expires).toBe(-1);
        expect(state.cookies[1]?.expires).toBe(12345);
    });

    it("forces secure on sameSite None cookies", () => {
        const state = sanitizeStorageState({
            cookies: [
                { name: "a", value: "1", domain: "app.example", sameSite: "None" },
                { name: "b", value: "2", domain: "app.example", sameSite: "None", secure: true },
                { name: "c", value: "3", domain: "app.example", sameSite: "Lax" },
            ],
        });
        expect(state.cookies[0]?.secure).toBe(true);
        expect(state.cookies[1]?.secure).toBe(true);
        expect(state.cookies[2]?.secure).toBeUndefined();
    });

    it("keeps coercing invalid sameSite to Lax and skipping malformed entries", () => {
        const state = sanitizeStorageState({
            cookies: [
                { name: "a", value: "1", domain: "app.example", sameSite: "bogus" },
                { noName: true },
                "not-a-cookie",
            ],
        });
        expect(state.cookies).toHaveLength(1);
        expect(state.cookies[0]?.sameSite).toBe("Lax");
    });
});
