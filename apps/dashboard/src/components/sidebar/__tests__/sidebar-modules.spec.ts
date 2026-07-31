import type { HitlWorkflowRecord } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import { mapServerChatMessage, mergeChatMessages } from "../chat/message-mapper";
import { checkFileMentionAutocomplete, insertFileMention } from "../composer/mention-utils";
import {
    computeHitlPending,
    deriveRunResolution,
    deriveSaveResolution,
    rehydrateWorkflowHitlCards,
} from "../hitl/workflow-state";
import { formatInterruptedAssistantMessage } from "../stream/parse-stream";
import type { Message } from "../types";

function msg(overrides: Partial<Message> & { id: string }): Message {
    return {
        content: "",
        timestamp: "10:00 AM",
        isUser: false,
        ...overrides,
    };
}

const saveHitl = {
    type: "save",
    title: "t",
    message: "m",
    reasons: [],
    options: [],
    context: { workflowId: "wf-1" },
    kind: "save_approval" as const,
};

const runHitl = {
    type: "run",
    title: "t",
    message: "m",
    reasons: [],
    options: [],
    context: { workflowId: "wf-2" },
    kind: "run_approval" as const,
};

const activeSaveWorkflow: HitlWorkflowRecord = {
    id: "wf-1",
    version: 1,
    kind: "test_generate_repair",
    status: "await_save_approval",
    createdAt: 1,
    updatedAt: 1,
    origin: "dashboard",
    testDraft: "test();",
    shouldRunTests: true,
    repairAttempts: 0,
};

describe("computeHitlPending", () => {
    it("is false with no messages or workflows", () => {
        expect(computeHitlPending([], [])).toBe(false);
    });

    it("is true when an active workflow exists", () => {
        expect(computeHitlPending([], [activeSaveWorkflow])).toBe(true);
    });

    it("is true for an unresolved save card backed by an active workflow", () => {
        expect(
            computeHitlPending([msg({ id: "1", hitlData: saveHitl })], [activeSaveWorkflow]),
        ).toBe(true);
    });

    it("is false once the workflow leaves await_save_approval", () => {
        expect(
            computeHitlPending(
                [msg({ id: "1", hitlData: saveHitl })],
                [],
                {
                    "1": { status: "saved", filePath: "e2e/a.spec.ts" },
                },
                {},
                true,
            ),
        ).toBe(false);
    });

    it("ignores legacy proceed/cancel cards without a kind", () => {
        expect(
            computeHitlPending(
                [
                    msg({
                        id: "3",
                        hitlData: {
                            type: "goal_classification",
                            title: "t",
                            message: "m",
                            reasons: [],
                            options: [],
                            context: {},
                        },
                    }),
                ],
                [],
            ),
        ).toBe(false);
    });
});

describe("deriveSaveResolution", () => {
    it("returns undefined while workflow awaits save approval", () => {
        expect(
            deriveSaveResolution({ id: "1", hitlData: saveHitl }, [activeSaveWorkflow], {}),
        ).toBeUndefined();
    });

    it("stays pending when workflow is absent before an authoritative query", () => {
        expect(
            deriveSaveResolution({ id: "1", hitlData: saveHitl }, [], {}, false),
        ).toBeUndefined();
    });

    it("returns handled for terminal workflows after an authoritative query", () => {
        expect(deriveSaveResolution({ id: "1", hitlData: saveHitl }, [], {}, true)).toEqual({
            status: "handled",
        });
    });
});

describe("deriveRunResolution", () => {
    it("uses session resolution for legacy cards", () => {
        expect(
            deriveRunResolution({ id: "2", hitlData: { ...runHitl, context: {} } }, [], {
                "2": { status: "skipped" },
            }),
        ).toEqual({ status: "skipped" });
    });

    it("returns handled for terminal run workflows after an authoritative query", () => {
        expect(deriveRunResolution({ id: "2", hitlData: runHitl }, [], {}, true)).toEqual({
            status: "handled",
        });
    });

    it("stays pending when run workflow is absent before an authoritative query", () => {
        expect(deriveRunResolution({ id: "2", hitlData: runHitl }, [], {}, false)).toBeUndefined();
    });
});

describe("rehydrateWorkflowHitlCards", () => {
    it("restores an actionable save card without duplicating it", () => {
        const restored = rehydrateWorkflowHitlCards([], [activeSaveWorkflow]);
        expect(restored).toHaveLength(1);
        expect(restored[0]?.hitlData?.context.workflowId).toBe(activeSaveWorkflow.id);
        expect(rehydrateWorkflowHitlCards(restored, [activeSaveWorkflow])).toBe(restored);
    });
});

describe("formatInterruptedAssistantMessage", () => {
    it("preserves partial content when generation is stopped", () => {
        expect(formatInterruptedAssistantMessage("partial response", "aborted", true)).toBe(
            "partial response\n\n_Stopped._",
        );
    });
});

describe("mergeChatMessages", () => {
    it("preserves streaming messages while merging canonical server writes", () => {
        const local: Message[] = [
            msg({ id: "welcome", content: "hi" }),
            msg({ id: "stream", content: "partial", isLoading: true }),
        ];
        const server = [
            mapServerChatMessage({
                id: "repl-1",
                content: "from repl",
                sender: "user",
                timestamp: 100,
            }),
        ];
        const merged = mergeChatMessages(local, server);
        expect(merged.some((m) => m.id === "repl-1")).toBe(true);
        expect(merged.some((m) => m.id === "stream" && m.isLoading)).toBe(true);
    });
});

describe("file mention autocomplete", () => {
    it("opens on bare @ and filters by path", () => {
        let shown = false;
        let filtered: Array<{ path: string; name: string }> = [];
        checkFileMentionAutocomplete(
            "@src",
            4,
            [
                { path: "src/a.ts", name: "a.ts" },
                { path: "lib/b.ts", name: "b.ts" },
            ],
            (value) => {
                shown = value;
            },
            (files) => {
                filtered = files;
            },
            () => {},
        );
        expect(shown).toBe(true);
        expect(filtered).toHaveLength(1);
    });

    it("inserts a selected path after @", () => {
        const result = insertFileMention("look at @", 9, {
            path: "src/login.ts",
            name: "login.ts",
        });
        expect(result.value).toBe("look at @src/login.ts ");
        expect(result.cursorPos).toBe(8 + "src/login.ts".length + 2);
    });
});
