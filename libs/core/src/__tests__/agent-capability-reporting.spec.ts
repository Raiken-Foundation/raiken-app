import { describe, expect, it } from "vitest";

import { buildSummary } from "../agent/graph/utils";
import { buildExplorationPrompt, type ContextData } from "../agent/prompts";

const emptyContext: ContextData = {
    files: [],
    projectType: "typescript",
    testDirectory: "tests",
    totalTokens: 0,
};

describe("agent capability reporting", () => {
    it("instructs exploratory answers to disclose unavailable capabilities", () => {
        const prompt = buildExplorationPrompt(emptyContext, "deploy this app");

        expect(prompt).toContain("If the requested action is not available");
        expect(prompt).toContain("state that limitation explicitly");
        expect(prompt).toContain("exact command or UI action");
    });

    it("never reports an empty run as successfully completed", () => {
        expect(buildSummary({})).toBe(
            "I could not complete an action or produce a grounded result. Please restate the request, or use `/help` to see the actions available in chat.",
        );
    });
});
