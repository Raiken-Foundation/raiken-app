import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_KEY_PATTERN } from "../redact";

/**
 * Pins the secret-redaction contract for error text. The original tests only
 * exercised ~2 of the 9 SECRET_VALUE_PATTERNS and 1 of the 10 key shapes, so a
 * mutant that emptied the whole pattern array survived. Each entry below is a
 * representative value for one pattern — removing or breaking that pattern
 * must fail its assertion.
 */
describe("redactSecrets", () => {
    const secretCases: Array<[string, string]> = [
        ["generic sk- (8+ chars)", "sk-abcdefgh1234"],
        // Short tails deliberately pin the specific sk-or-v1- / sk-ant-
        // patterns: the generic sk- pattern requires 8+ chars after "sk-",
        // so it does not match these, and only the specific pattern will.
        ["sk-or-v1- (short tail)", "sk-or-v1-a"],
        ["sk-ant- (short tail)", "sk-ant-a"],
        ["gsk_", "gsk_abc123def"],
        ["AIza (Google API key)", `AIza${"a".repeat(20)}`],
        ["pplx- (Perplexity)", "pplx-abc123def"],
        ["xai-", "xai-abc123def"],
        ["Bearer token", "Bearer abc.def.ghi-jkl"],
        ["Basic credentials", "Basic dXNlcjpwYXNz"],
    ];

    it.each(secretCases)("redacts %s secrets", (_label, secret) => {
        const redacted = redactSecrets(`prefix ${secret} suffix`);
        expect(redacted).not.toContain(secret);
        expect(redacted).toContain("[REDACTED]");
    });

    it("redacts every pattern family in a single string (pins the whole array)", () => {
        const all = [
            "sk-abcdefgh1234",
            "sk-or-v1-deadbeef",
            "sk-ant-api03-xyz",
            "gsk_abc123def",
            `AIza${"a".repeat(20)}`,
            "pplx-abc123def",
            "xai-abc123def",
            "Bearer abc.def.ghi",
            "Basic dXNlcjpwYXNz",
        ].join(" ");

        const redacted = redactSecrets(all);

        // No secret body may survive anywhere.
        for (const fragment of [
            "abcdefgh1234",
            "deadbeef",
            "api03-xyz",
            "abc123def",
            "abc.def.ghi",
            "dXNlcjpwYXNz",
        ]) {
            expect(redacted).not.toContain(fragment);
        }
    });

    it("redacts every occurrence, not just the first", () => {
        const redacted = redactSecrets("sk-abcdefgh1234 then sk-abcdefgh1234");
        expect(redacted).not.toContain("sk-abcdefgh1234");
        expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
    });

    it("leaves non-secret text untouched", () => {
        expect(redactSecrets("just a normal message")).toBe("just a normal message");
    });
});

describe("SECRET_KEY_PATTERN", () => {
    const matching = [
        "password",
        "secret",
        "token",
        "apiKey",
        "api_key",
        "api-key",
        "authorization",
        "credential",
        "private_key",
        "private-key",
    ];

    it.each(matching)("matches secret key %s", (key) => {
        expect(SECRET_KEY_PATTERN.test(key)).toBe(true);
    });

    // The ^...$ anchors matter: dropping them would let keys that merely
    // *contain* these words leak through (e.g. "passwordHash", "mySecret").
    const notMatching = [
        "passwordHash",
        "myPassword",
        "secrets",
        "tokens",
        "x-api-key",
        "api_key_extra",
        "authorizationHeader",
        "credentialStore",
        "private_key_pem",
        "",
    ];

    it.each(notMatching)("does not match partial key %s", (key) => {
        expect(SECRET_KEY_PATTERN.test(key)).toBe(false);
    });
});
