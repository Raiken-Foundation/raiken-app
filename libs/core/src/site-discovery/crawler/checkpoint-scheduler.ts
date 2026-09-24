import type { SiteKnowledgeDB } from "../db";
import type { CrawlerEventPayload, PendingRequest } from "./types";

export const CHECKPOINT_INTERVAL_MS = 15_000;
export const GRACEFUL_PAUSE_DRAIN_MS = 5_000;
export const GRACEFUL_PAUSE_POLL_MS = 50;

export type CheckpointSchedulerDeps = {
    sessionId: () => number | null;
    pendingRequests: Map<string, PendingRequest>;
    siteDb: SiteKnowledgeDB;
    startUrl: string;
    emit: (event: CrawlerEventPayload) => boolean;
    isCheckpointFailureWarned: () => boolean;
    markCheckpointFailureWarned: () => void;
};

export class CheckpointScheduler {
    private checkpointTimer: NodeJS.Timeout | null = null;
    private wallClockTimer: NodeJS.Timeout | null = null;

    constructor(private readonly deps: CheckpointSchedulerDeps) {}

    armCheckpointTimer(): void {
        void this.persistQueueState().catch(() => {});
        this.checkpointTimer = setInterval(() => {
            void this.persistQueueState().catch(() => {});
        }, CHECKPOINT_INTERVAL_MS);
        if (typeof this.checkpointTimer.unref === "function") {
            this.checkpointTimer.unref();
        }
    }

    disarmCheckpointTimer(): void {
        if (this.checkpointTimer) {
            clearInterval(this.checkpointTimer);
            this.checkpointTimer = null;
        }
    }

    armWallClockTimer(maxRunTimeMs: number, onCap: () => void): void {
        if (!maxRunTimeMs || maxRunTimeMs <= 0) return;
        this.wallClockTimer = setTimeout(() => {
            console.warn(
                `Discovery hit wall-clock cap of ${Math.round(maxRunTimeMs / 1000)}s — pausing.`,
            );
            onCap();
        }, maxRunTimeMs);
        if (typeof this.wallClockTimer.unref === "function") {
            this.wallClockTimer.unref();
        }
    }

    disarmWallClockTimer(): void {
        if (this.wallClockTimer) {
            clearTimeout(this.wallClockTimer);
            this.wallClockTimer = null;
        }
    }

    disarmAll(): void {
        this.disarmWallClockTimer();
        this.disarmCheckpointTimer();
    }

    async persistQueueState(): Promise<void> {
        const sessionId = this.deps.sessionId();
        if (!sessionId) {
            return;
        }

        try {
            const serialized = Array.from(this.deps.pendingRequests.values()).map((request) => ({
                url: request.url,
                uniqueKey: request.uniqueKey,
                userData: request.userData,
            }));

            this.deps.siteDb.updateSession(sessionId, {
                queueJson: JSON.stringify(serialized),
            });
        } catch (err) {
            if (!this.deps.isCheckpointFailureWarned()) {
                this.deps.markCheckpointFailureWarned();
                this.deps.emit({
                    type: "warning",
                    data: {
                        code: "checkpoint_failed",
                        url: this.deps.startUrl,
                        message: `Failed to checkpoint discovery queue; resuming after an interruption may lose unvisited pages: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    },
                    timestamp: Date.now(),
                });
            }
        }
    }
}

export async function waitForCrawlerConcurrencyBelow(
    getCurrentConcurrency: () => number | undefined,
    threshold: number,
): Promise<void> {
    const deadline = Date.now() + GRACEFUL_PAUSE_DRAIN_MS;
    while ((getCurrentConcurrency() ?? 0) > threshold && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, GRACEFUL_PAUSE_POLL_MS));
    }
}
