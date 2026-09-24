import { describe, expect, it } from "vitest";
import { agentStreamErrorMessage, parseAgentStreamError } from "../agent-stream-events";

describe("agent stream SSE error contract", () => {
    it("parses legacy string errors", () => {
        expect(parseAgentStreamError("Generation failed")).toEqual({
            message: "Generation failed",
        });
        expect(agentStreamErrorMessage("Generation failed")).toBe("Generation failed");
    });

    it("parses structured safe error payloads", () => {
        const parsed = parseAgentStreamError({
            message: "Provider unavailable",
            raikenCode: "AI_UNAVAILABLE",
            retryable: true,
            correlationId: "abc123",
        });
        expect(parsed).toMatchObject({
            message: "Provider unavailable",
            raikenCode: "AI_UNAVAILABLE",
            retryable: true,
            correlationId: "abc123",
        });
        expect(agentStreamErrorMessage(parsed)).toBe("Provider unavailable");
    });

    it("never produces [object Object] for malformed payloads", () => {
        expect(agentStreamErrorMessage({} as never)).toBe("An unexpected error occurred.");
        expect(agentStreamErrorMessage(null as never)).toBe("An unexpected error occurred.");
    });

    it("matches server SSE envelope shape", () => {
        const serverPayload = {
            error: {
                message: "Test generation failed",
                raikenCode: "INTERNAL",
                retryable: false,
                correlationId: "c1",
            },
        };
        const message = agentStreamErrorMessage(serverPayload.error);
        expect(message).toBe("Test generation failed");
        expect(message).not.toContain("[object Object]");
    });
});
