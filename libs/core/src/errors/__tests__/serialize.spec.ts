import { describe, expect, it } from "vitest";
import { internalError } from "../raiken-error";
import { serializeSafeHttpErrorBody } from "../serialize";

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
