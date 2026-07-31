import { describe, expect, it } from "vitest";

import { redactToolArgs } from "../agent/agent";

describe("tool argument redaction", () => {
    it("redacts generic text-entry values before callbacks and traces", () => {
        expect(
            redactToolArgs("fillInput", {
                selector: 'input[name="password"]',
                value: "super-secret",
            }),
        ).toEqual({
            selector: 'input[name="password"]',
            value: "[REDACTED]",
        });
    });

    it("recursively redacts secret-shaped keys for every tool", () => {
        expect(
            redactToolArgs("someTool", {
                safe: "visible",
                nested: { apiKey: "key", credential: "value" },
            }),
        ).toEqual({
            safe: "visible",
            nested: { apiKey: "[REDACTED]", credential: "[REDACTED]" },
        });
    });
});
