import { describe, expect, it } from "vitest";
import { redactString, redactValue } from "../redaction";

describe("observability redaction", () => {
    it("redacts bearer tokens and secret keys", () => {
        expect(redactString("Authorization Bearer sk-or-v1-deadbeef")).not.toContain("sk-or-v1");
        expect(redactString("Authorization Bearer sk-or-v1-deadbeef")).toContain("[redacted]");

        const value = redactValue({
            apiKey: "sk-secret",
            note: "token=abc in query ?access_token=secret",
        }) as Record<string, unknown>;

        expect(value.apiKey).toBe("[redacted]");
        expect(JSON.stringify(value)).not.toContain("secret");
    });

    it("truncates very long strings", () => {
        const out = redactString("a".repeat(100), 20);
        expect(out).toContain("[+80 chars]");
    });
});
