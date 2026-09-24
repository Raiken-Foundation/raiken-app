import { afterEach, describe, expect, it, vi } from "vitest";
import {
    configureObservability,
    obs,
    readObservabilityConfigFromEnv,
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
        vi.restoreAllMocks();
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

describe("obs helpers", () => {
    const events: ObservabilityEvent[] = [];
    const sink = (event: ObservabilityEvent) => events.push(event);

    afterEach(() => {
        events.length = 0;
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        setObservabilitySink(null);
        resetObservabilityForTests();
    });

    it("emits the right level for each helper", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.debug("d");
        obs.info("i");
        obs.warn("w");
        obs.error("e");

        expect(events.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
    });

    it("obs.duration computes elapsed ms and defaults to info level", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        vi.spyOn(Date, "now").mockReturnValue(1042);
        obs.duration("op", 1000);

        expect(events[0].durationMs).toBe(42);
        expect(events[0].level).toBe("info");
    });

    it("obs.duration honours an explicit level override", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.duration("op", 1000, { level: "warn" });

        expect(events[0].level).toBe("warn");
    });
});

describe("emitObservabilityEvent redaction and context", () => {
    const events: ObservabilityEvent[] = [];
    const sink = (event: ObservabilityEvent) => events.push(event);

    afterEach(() => {
        events.length = 0;
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        setObservabilitySink(null);
        resetObservabilityForTests();
    });

    it("redacts secrets in the message before the sink sees it", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.info("auth", { message: "token=sk-abcdefgh1234 failed" });

        expect(events[0].message).not.toContain("sk-abcdefgh1234");
        expect(events[0].message).toContain("[redacted]");
    });

    it("redacts secrets inside meta values", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.info("auth", { meta: { apiKey: "sk-abcdefgh1234" } });

        expect((events[0].meta as Record<string, unknown>).apiKey).toBe("[redacted]");
    });

    it("stamps a numeric at timestamp", () => {
        configureObservability({ minLevel: "debug" });
        setObservabilitySink(sink);

        obs.info("evt");

        expect(typeof events[0].at).toBe("number");
    });
});

describe("default sink (human + json)", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        setObservabilitySink(null);
        resetObservabilityForTests();
    });

    it("formats duration, status, ids, and message on one line", () => {
        vi.stubEnv("RAIKEN_LOG_JSON", "");
        resetObservabilityForTests();
        configureObservability({ minLevel: "debug" });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        obs.info("test.event", {
            durationMs: 42,
            status: "ok",
            correlationId: "cid-1",
            operationId: "op-1",
            runId: "run-1",
            message: "hello",
        });

        expect(logSpy).toHaveBeenCalledWith(
            "[info] test.event 42ms ok cid=cid-1 op=op-1 run=run-1 — hello",
        );
    });

    it("omits the message separator when there is no message", () => {
        vi.stubEnv("RAIKEN_LOG_JSON", "");
        resetObservabilityForTests();
        configureObservability({ minLevel: "debug" });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        obs.info("test.event", { correlationId: "cid-1" });

        expect(logSpy).toHaveBeenCalledWith("[info] test.event cid=cid-1");
    });

    it("routes levels to the matching console method", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "debug");
        resetObservabilityForTests();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        obs.error("e");
        obs.warn("w");
        obs.debug("d");
        obs.info("i");

        expect(errorSpy).toHaveBeenCalledWith("[error] e");
        expect(warnSpy).toHaveBeenCalledWith("[warn] w");
        expect(debugSpy).toHaveBeenCalledWith("[debug] d");
        expect(logSpy).toHaveBeenCalledWith("[info] i");
    });

    it("writes JSON to stderr when RAIKEN_LOG_JSON is enabled", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "debug");
        vi.stubEnv("RAIKEN_LOG_JSON", "1");
        resetObservabilityForTests();
        const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        obs.info("test.event", { message: "hello" });

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const written = JSON.parse(writeSpy.mock.calls[0][0] as string);
        expect(written).toMatchObject({ level: "info", event: "test.event", message: "hello" });
    });
});

describe("readObservabilityConfigFromEnv", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        resetObservabilityForTests();
    });

    it("parses RAIKEN_LOG_JSON truthy values", () => {
        for (const val of ["1", "true", "TRUE", "True"]) {
            vi.stubEnv("RAIKEN_LOG_JSON", val);
            expect(readObservabilityConfigFromEnv().jsonLogging).toBe(true);
        }
    });

    it("treats any other RAIKEN_LOG_JSON value as false", () => {
        for (const val of ["", "0", "false", "yes", "2"]) {
            vi.stubEnv("RAIKEN_LOG_JSON", val);
            expect(readObservabilityConfigFromEnv().jsonLogging).toBe(false);
        }
    });

    it("falls back to error for an unknown level", () => {
        vi.stubEnv("RAIKEN_LOG_LEVEL", "loud");
        expect(readObservabilityConfigFromEnv().minLevel).toBe("error");
    });

    it("accepts every known level", () => {
        for (const level of ["debug", "info", "warn", "error"]) {
            vi.stubEnv("RAIKEN_LOG_LEVEL", level);
            expect(readObservabilityConfigFromEnv().minLevel).toBe(level);
        }
    });
});
