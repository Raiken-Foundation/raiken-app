import { describe, expect, it } from "vitest";
import { DiscoveryCoordinator } from "../coordinator";

describe("DiscoveryCoordinator", () => {
    it("owns runtime state, bounded events, and in-process job identity", () => {
        const coordinator = new DiscoveryCoordinator();
        expect(coordinator.getState("/tmp/project").phase).toBe("idle");
        coordinator.patchState("/tmp/project", { phase: "running" });
        coordinator.pushEvent("/tmp/project", { type: "started", message: "Started" });
        expect(coordinator.getState("/tmp/project")).toMatchObject({
            phase: "running",
            lastEvents: [{ type: "started", message: "Started" }],
        });

        const job = { discovery: {} as never, promise: Promise.resolve() };
        coordinator.jobStore.set("/tmp/project", job);
        expect(coordinator.jobStore.get("/tmp/project")).toBe(job);
        expect(coordinator.jobStore.delete("/tmp/project")).toBe(true);
    });
});
