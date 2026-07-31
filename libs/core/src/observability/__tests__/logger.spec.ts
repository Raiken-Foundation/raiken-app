import { afterEach, describe, expect, it, vi } from "vitest";
import {
    configureObservability,
    obs,
    resetObservabilityForTests,
    setObservabilitySink,
} from "../logger";
import type { ObservabilityEvent } from "../types";

describe("observability logger defaults", () => {
    const events: ObservabilityEvent[] = [];
    const sink = (event: ObservabilityEvent) => events.push(event);

    afterEach(() => {
        events.length = 0;
        vi.unstubAllEnvs();
        setObservabilitySink(null);
        resetObservabilityForTests();
    });

    it("suppresses info and warn lifecycle events by default", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "");
        resetObservabilityForTests();
        setObservabilitySink(sink);

        obs.info("test.run.started");
        obs.warn("test.run.completed", { status: "failed" });
        obs.error("test.run.failed", { status: "error" });

        expect(events.map((e) => e.level)).toEqual(["error"]);
    });

    it("honours RAIKEN_LOG_LEVEL opt-in", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "info");
        resetObservabilityForTests();
        setObservabilitySink(sink);

        obs.info("test.run.started");

        expect(events.map((e) => e.level)).toEqual(["info"]);
    });

    it("configureObservability overrides the env default", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "");
        resetObservabilityForTests();
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.debug("fine.grained");

        expect(events.map((e) => e.level)).toEqual(["debug"]);
    });
});
