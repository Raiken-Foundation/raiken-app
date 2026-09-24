import { describe, expect, it } from "vitest";
import { internalError, validationError } from "../raiken-error";
import {
    redactErrorDetails,
    serializeSafeClientError,
    serializeSafeHttpErrorBody,
} from "../serialize";

describe("serializeSafeHttpErrorBody", () => {
    it("keeps error as a safe string for legacy HTTP consumers", () => {
        const body = serializeSafeHttpErrorBody(
            internalError("Database locked", { details: { token: "sk-secret-key-abc" } }),
        );
        expect(typeof body.error).toBe("string");
        expect(body.error).toBe("Database locked");
        expect(body.detail).toBe(body.error);
        expect(body.error).not.toContain("sk-secret");
    });

    it("adds structured metadata under raiken", () => {
        const body = serializeSafeHttpErrorBody(internalError("Not found"));
        expect(body.raiken).toMatchObject({
            message: "Not found",
            code: expect.any(String),
        });
    });
});

describe("redactErrorDetails", () => {
    it("redacts every secret key shape in details, not just apiKey", () => {
        const redacted = redactErrorDetails({
            apiKey: "sk-abcdefgh1234",
            password: "hunter2",
            token: "Bearer abc.def",
            authorization: "Bearer xyz",
            credential: "creds",
            private_key: "pk",
            // Non-secret values must pass through unchanged.
            path: "ai.model",
            provider: "openai",
        });

        expect(redacted).toMatchObject({
            apiKey: "[REDACTED]",
            password: "[REDACTED]",
            token: "[REDACTED]",
            authorization: "[REDACTED]",
            credential: "[REDACTED]",
            private_key: "[REDACTED]",
            path: "ai.model",
            provider: "openai",
        });
    });

    it("redacts secret strings inside array detail values", () => {
        const redacted = redactErrorDetails({
            errors: ["sk-abcdefgh1234 failed", "plain message"],
        });

        expect(redacted?.errors).toEqual(["[REDACTED] failed", "plain message"]);
    });

    it("returns undefined for undefined details", () => {
        expect(redactErrorDetails(undefined)).toBeUndefined();
    });
});

describe("serializeSafeClientError", () => {
    it("redacts secret-shaped detail keys and secret values in one pass", () => {
        const safe = serializeSafeClientError(
            validationError("invalid", {
                details: {
                    password: "hunter2",
                    tokens: ["sk-abcdefgh1234", "ok"],
                },
            }),
        );

        expect(safe.details).toMatchObject({
            password: "[REDACTED]",
            tokens: ["[REDACTED]", "ok"],
        });
    });
});
