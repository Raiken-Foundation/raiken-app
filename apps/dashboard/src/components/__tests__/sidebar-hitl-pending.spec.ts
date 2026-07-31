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
        expect(computeHitlPending([], [])).toBe(false);
    });

    it("is true for an unresolved save_approval card with active workflow", () => {
        const workflow: HitlWorkflowRecord = {
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
        const messages = [
            msg({
                id: "1",
                hitlData: {
                    type: "save",
                    title: "t",
                    message: "m",
                    reasons: [],
                    options: [],
                    context: { workflowId: "wf-1" },
                    kind: "save_approval",
                },
            }),
        ];
        expect(computeHitlPending(messages, [workflow])).toBe(true);
    });

    it("is false once the save card is resolved in session", () => {
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
        expect(computeHitlPending(messages, [], { "1": { status: "saved" } })).toBe(false);
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
