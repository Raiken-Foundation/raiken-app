import { describe, expect, it } from "vitest";
import { redactString, redactValue, SECRET_KEY_PATTERN, truncateString } from "../redaction";

/**
 * Pins the observability redaction contract. The original test exercised only
 * one bearer token and one apiKey — so every other SECRET_VALUE_REPLACEMENTS
 * pattern and nearly every redactValue branch was mutation-invisible.
 */
describe("redactString (SECRET_VALUE_REPLACEMENTS)", () => {
    const cases: Array<[string, string, string]> = [
        // [label, input, expected]
        ["Bearer token (keeps prefix)", "Authorization: Bearer abc.def.ghi", "Bearer [redacted]"],
        ["sk- key", "key=sk-abcdefgh1234", "[redacted]"],
        ["rk- key", "key=rk-abcdefgh1234", "[redacted]"],
        ["pk- key", "key=pk-abcdefgh1234", "[redacted]"],
        ["sk_ key (underscore)", "key=sk_abcdefgh1234", "[redacted]"],
        ["JWT", "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", "[redacted]"],
        ["access_token query param", "url?access_token=secret123", "access_token=[redacted]"],
        ["api_key query param", "url&api_key=secret123", "api_key=[redacted]"],
        ["sk-or-v1- key", "key=sk-or-v1-deadbeef", "[redacted]"],
        ["sk-ant- key", "key=sk-ant-api03-xyz", "[redacted]"],
    ];

    it.each(cases)("redacts %s", (_label, input, expected) => {
        const out = redactString(input);
        expect(out).not.toContain("secret123");
        expect(out).not.toContain("deadbeef");
        expect(out).not.toContain("api03-xyz");
        expect(out).toContain("[redacted]");
        expect(out).toContain(expected);
    });

    it("redacts every pattern family in one string", () => {
        const all = [
            "Bearer abc.def.ghi",
            "sk-abcdefgh1234",
            "rk-abcdefgh1234",
            "pk-abcdefgh1234",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
            "?access_token=secret123",
            "&api_key=secret456",
            "sk-or-v1-deadbeef",
            "sk-ant-api03-xyz",
        ].join(" ");
        const out = redactString(all);
        for (const fragment of [
            "abc.def.ghi",
            "abcdefgh1234",
            "secret123",
            "secret456",
            "deadbeef",
            "api03-xyz",
        ]) {
            expect(out).not.toContain(fragment);
        }
    });

    it("leaves non-secret text untouched", () => {
        expect(redactString("normal log line")).toBe("normal log line");
    });
});

describe("truncateString", () => {
    it("returns short strings unchanged", () => {
        expect(truncateString("short", 100)).toBe("short");
    });

    it("truncates at the boundary exactly", () => {
        expect(truncateString("a".repeat(10), 10)).toBe("a".repeat(10));
    });

    it("truncates and reports the dropped char count", () => {
        const out = truncateString("a".repeat(100), 20);
        expect(out).toBe(`${"a".repeat(20)}… [+80 chars]`);
    });
});

describe("redactValue", () => {
    it("passes null and undefined through untouched", () => {
        expect(redactValue(null)).toBeNull();
        expect(redactValue(undefined)).toBeUndefined();
    });

    it("passes numbers and booleans through untouched", () => {
        expect(redactValue(42)).toBe(42);
        expect(redactValue(true)).toBe(true);
    });

    it("redacts secret key values, whatever their shape", () => {
        const value = redactValue({
            apiKey: "sk-abcdefgh1234",
            password: "hunter2",
            token: "Bearer abc.def",
            authorization: "Bearer xyz",
            cookie: "session-cookie",
            session_id: "sess-123",
            "session-id": "sess-456",
            credential: "creds",
            private_key: "pk",
            "private-key": "pk",
            safe: "keep me",
        }) as Record<string, unknown>;

        for (const key of [
            "apiKey",
            "password",
            "token",
            "authorization",
            "cookie",
            "session_id",
            "session-id",
            "credential",
            "private_key",
            "private-key",
        ]) {
            expect(value[key]).toBe("[redacted]");
        }
        expect(value.safe).toBe("keep me");
    });

    it("redacts secret values inside arrays", () => {
        const value = redactValue([1, "sk-abcdefgh1234", null, true]) as unknown[];
        expect(value[0]).toBe(1);
        expect(value[1]).toBe("[redacted]");
        expect(value[2]).toBeNull();
        expect(value[3]).toBe(true);
    });

    it("redacts deeply nested secrets", () => {
        const value = redactValue({
            outer: { inner: { apiKey: "sk-abcdefgh1234" } },
        }) as { outer: { inner: { apiKey: string } } };
        expect(value.outer.inner.apiKey).toBe("[redacted]");
    });

    it("caps recursion at max depth", () => {
        // Build a 10-level nested object.
        let deep: unknown = "bottom";
        for (let i = 0; i < 10; i++) deep = { level: deep };
        const out = JSON.stringify(redactValue(deep));
        expect(out).toContain("[max depth]");
    });

    it("caps arrays at 100 entries", () => {
        const big = Array.from({ length: 150 }, (_, i) => i);
        const out = redactValue(big) as number[];
        expect(out).toHaveLength(100);
    });
});

describe("SECRET_KEY_PATTERN", () => {
    it("matches secret-shaped key names (substring, case-insensitive)", () => {
        const matching = [
            "password",
            "secret",
            "token",
            "api_key",
            "api-key",
            "authorization",
            "cookie",
            "session_id",
            "session-id",
            "credential",
            "private_key",
            "private-key",
            "API_KEY",
        ];
        for (const key of matching) {
            expect(SECRET_KEY_PATTERN.test(key)).toBe(true);
        }
    });

    it("does not match ordinary keys", () => {
        const ordinary = ["path", "model", "provider", "name", "id"];
        for (const key of ordinary) {
            expect(SECRET_KEY_PATTERN.test(key)).toBe(false);
        }
    });
});
