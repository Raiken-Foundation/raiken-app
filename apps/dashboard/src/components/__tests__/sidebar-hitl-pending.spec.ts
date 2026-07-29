import type { HitlWorkflowRecord } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import {
    computeHitlPending,
    formatInterruptedAssistantMessage,
    type Message,
    rehydrateWorkflowHitlCards,
} from "../sidebar";

function msg(overrides: Partial<Message> & { id: string }): Message {
    return {
        content: "",
        timestamp: "10:00 AM",
        isUser: false,
        ...overrides,
    };
}

describe("computeHitlPending", () => {
    it("is false with no messages", () => {
        expect(computeHitlPending([], {}, {})).toBe(false);
    });

    it("is false when no message carries hitlData", () => {
        const messages = [msg({ id: "1" }), msg({ id: "2", isUser: true })];
        expect(computeHitlPending(messages, {}, {})).toBe(false);
    });

    it("is true for an unresolved save_approval card", () => {
        const messages = [
            msg({
                id: "1",
                hitlData: {
                    type: "save",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "save_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, {}, {})).toBe(true);
    });

    it("is false once the save_approval card is resolved", () => {
        const messages = [
            msg({
                id: "1",
                hitlData: {
                    type: "save",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "save_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, { "1": { status: "saved" } }, {})).toBe(false);
    });

    it("is true for an unresolved run_approval card", () => {
        const messages = [
            msg({
                id: "2",
                hitlData: {
                    type: "run",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "run_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, {}, {})).toBe(true);
    });

    it("is false once the run_approval card is resolved", () => {
        const messages = [
            msg({
                id: "2",
                hitlData: {
                    type: "run",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "run_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, {}, { "2": { status: "skipped" } })).toBe(false);
    });

    it("ignores legacy proceed/cancel cards without a kind", () => {
        const messages = [
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
        ];
        expect(computeHitlPending(messages, {}, {})).toBe(false);
    });

    it("ignores hitlData on user messages", () => {
        const messages = [
            msg({
                id: "4",
                isUser: true,
                hitlData: {
                    type: "save",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "save_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, {}, {})).toBe(false);
    });

    it("is true if any one of several messages has an unresolved card", () => {
        const messages = [
            msg({
                id: "5",
                hitlData: {
                    type: "save",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "save_approval",
                },
            }),
            msg({
                id: "6",
                hitlData: {
                    type: "run",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: {},
                    kind: "run_approval",
                },
            }),
        ];
        // "5" resolved, "6" still pending -> overall true.
        expect(computeHitlPending(messages, { "5": { status: "saved" } }, {})).toBe(true);
    });

    it("is true when an active workflow was recovered without chat history", () => {
        expect(computeHitlPending([], {}, {}, [{ status: "await_repair_review" }])).toBe(true);
    });
});

describe("rehydrateWorkflowHitlCards", () => {
    it("restores an actionable save card without duplicating it", () => {
        const workflow: HitlWorkflowRecord = {
            id: "workflow-1",
            version: 1,
            kind: "test_generate_repair",
            status: "await_save_approval",
            createdAt: 1,
            updatedAt: 1,
            origin: "dashboard",
            savedTestPath: "e2e/login.spec.ts",
            testDraft: 'test("login", async () => {});',
            testName: "login",
            shouldRunTests: true,
            repairAttempts: 0,
            pendingAction: "save",
        };
        const restored = rehydrateWorkflowHitlCards([], [workflow]);
        expect(restored).toHaveLength(1);
        expect(restored[0]?.hitlData?.context.workflowId).toBe(workflow.id);
        expect(rehydrateWorkflowHitlCards(restored, [workflow])).toBe(restored);
    });
});

describe("formatInterruptedAssistantMessage", () => {
    it("preserves partial content when generation is stopped", () => {
        expect(formatInterruptedAssistantMessage("partial response", "aborted", true)).toBe(
            "partial response\n\n_Stopped._",
        );
    });

    it("preserves partial content when the stream fails", () => {
        expect(formatInterruptedAssistantMessage("partial response", "network lost", false)).toBe(
            "partial response\n\n_Error: network lost_",
        );
    });
});
