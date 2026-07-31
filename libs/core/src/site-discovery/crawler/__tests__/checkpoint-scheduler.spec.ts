import { describe, expect, it, vi } from "vitest";

import { CheckpointScheduler } from "../checkpoint-scheduler";

describe("CheckpointScheduler contract", () => {
    it("persists pending queue immediately when armed (immediate checkpoint parity)", async () => {
        const pending = new Map([
            [
                "http://example.com/a",
                { url: "http://example.com/a", uniqueKey: "http://example.com/a" },
            ],
        ]);
        const updateSession = vi.fn();
        const scheduler = new CheckpointScheduler({
            sessionId: () => 42,
            pendingRequests: pending,
            siteDb: { updateSession } as never,
            startUrl: "http://example.com/",
            emit: vi.fn(),
            isCheckpointFailureWarned: () => false,
            markCheckpointFailureWarned: vi.fn(),
        });

        scheduler.armCheckpointTimer();
        await new Promise((r) => setTimeout(r, 10));
        scheduler.disarmCheckpointTimer();

        expect(updateSession).toHaveBeenCalled();
        const payload = updateSession.mock.calls[0]?.[1] as { queueJson: string };
        const parsed = JSON.parse(payload.queueJson) as Array<{ url: string }>;
        expect(parsed.some((item) => item.url === "http://example.com/a")).toBe(true);
    });

    it("emits a one-time checkpoint_failed warning when persistence throws", async () => {
        const emit = vi.fn();
        let warned = false;
        const scheduler = new CheckpointScheduler({
            sessionId: () => 1,
            pendingRequests: new Map(),
            siteDb: {
                updateSession: () => {
                    throw new Error("disk full");
                },
            } as never,
            startUrl: "http://example.com/",
            emit,
            isCheckpointFailureWarned: () => warned,
            markCheckpointFailureWarned: () => {
                warned = true;
            },
        });

        await scheduler.persistQueueState();
        await scheduler.persistQueueState();

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0]?.[0]?.data?.code).toBe("checkpoint_failed");
    });
});
