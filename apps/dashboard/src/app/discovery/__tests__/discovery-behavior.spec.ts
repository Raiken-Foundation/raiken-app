import { describe, expect, it } from "vitest";
import {
    GENERATE_TEST_HANDOFF_MS,
    POLL_DATA_ACTIVE_MS,
    POLL_DATA_IDLE_MS,
    POLL_RUNTIME_ACTIVE_MS,
    POLL_RUNTIME_IDLE_MS,
} from "../constants";
import { parseOptionalPositiveInt, safeHttpUrl } from "../helpers";
import {
    buildGenerateTestToast,
    canContinueDiscovery,
    canStartDiscovery,
    computeProgressPct,
    deriveActionError,
    deriveDataPollMs,
    deriveQueryError,
    deriveRuntimePollMs,
    formatProvideStateError,
    isActionPending,
    isDiscoveryActionPending,
    isDiscoveryPaused,
    isDiscoveryRunning,
    isHandoffActive,
    resolveDataRefetchInterval,
    resolveRuntimeRefetchInterval,
    shouldShowCompletionBanner,
} from "../runtime-state";

describe("discovery polling intervals", () => {
    it("uses active runtime polling while running", () => {
        expect(deriveRuntimePollMs("running")).toBe(POLL_RUNTIME_ACTIVE_MS);
        expect(deriveDataPollMs("running")).toBe(POLL_DATA_ACTIVE_MS);
    });

    it("uses idle polling for non-running phases", () => {
        for (const phase of ["idle", "paused", "completed", "error"] as const) {
            expect(deriveRuntimePollMs(phase)).toBe(POLL_RUNTIME_IDLE_MS);
            expect(deriveDataPollMs(phase)).toBe(POLL_DATA_IDLE_MS);
        }
    });

    it("resolves runtime refetch interval from current query data without stale idle lag", () => {
        expect(resolveRuntimeRefetchInterval(undefined)).toBe(POLL_RUNTIME_IDLE_MS);
        expect(resolveRuntimeRefetchInterval({ phase: "idle" })).toBe(POLL_RUNTIME_IDLE_MS);
        expect(resolveRuntimeRefetchInterval({ phase: "running" })).toBe(POLL_RUNTIME_ACTIVE_MS);
        expect(resolveDataRefetchInterval("running")).toBe(POLL_DATA_ACTIVE_MS);
        expect(resolveDataRefetchInterval("completed")).toBe(POLL_DATA_IDLE_MS);
    });

    it("transitions runtime poll interval idle to running on the same query tick", () => {
        const idleInterval = resolveRuntimeRefetchInterval({ phase: "idle" });
        const runningInterval = resolveRuntimeRefetchInterval({ phase: "running" });
        expect(idleInterval).toBe(POLL_RUNTIME_IDLE_MS);
        expect(runningInterval).toBe(POLL_RUNTIME_ACTIVE_MS);
        expect(runningInterval).toBeLessThan(idleInterval);
    });
});

describe("discovery runtime phase flags", () => {
    it("detects running and paused states", () => {
        expect(isDiscoveryRunning("running")).toBe(true);
        expect(isDiscoveryRunning("paused")).toBe(false);
        expect(isDiscoveryPaused("paused", undefined)).toBe(true);
        expect(isDiscoveryPaused("idle", "paused")).toBe(true);
        expect(isDiscoveryPaused("running", "paused")).toBe(true);
    });

    it("computes progress only while running with a max page budget", () => {
        expect(computeProgressPct(true, 100, 25)).toBe(25);
        expect(computeProgressPct(false, 100, 25)).toBeNull();
        expect(computeProgressPct(true, undefined, 25)).toBeNull();
        expect(computeProgressPct(true, 10, 99)).toBe(100);
    });
});

describe("discovery action gating", () => {
    const idlePending = {
        start: false,
        continue: false,
        clear: false,
        pause: false,
        abort: false,
        dismissError: false,
        cancelHandoff: false,
        handoff: false,
    };

    it("blocks start while paused, running, or pending", () => {
        expect(
            canStartDiscovery({ url: "https://example.com", phase: "idle", actionPending: false }),
        ).toBe(true);
        expect(
            canStartDiscovery({
                url: "https://example.com",
                phase: "running",
                actionPending: false,
            }),
        ).toBe(false);
        expect(
            canStartDiscovery({
                url: "https://example.com",
                phase: "paused",
                sessionStatus: "paused",
                actionPending: false,
            }),
        ).toBe(false);
        expect(
            canStartDiscovery({
                url: "",
                phase: "idle",
                actionPending: false,
            }),
        ).toBe(false);
        expect(
            canStartDiscovery({
                url: "https://example.com",
                phase: "idle",
                actionPending: true,
            }),
        ).toBe(false);
    });

    it("allows continue only when paused and idle", () => {
        expect(
            canContinueDiscovery({
                phase: "paused",
                sessionStatus: "paused",
                actionPending: false,
            }),
        ).toBe(true);
        expect(
            canContinueDiscovery({
                phase: "running",
                actionPending: false,
            }),
        ).toBe(false);
        expect(
            canContinueDiscovery({
                phase: "paused",
                actionPending: true,
            }),
        ).toBe(false);
    });

    it("tracks mutation pending as action pending", () => {
        expect(isActionPending(idlePending)).toBe(false);
        expect(isActionPending({ ...idlePending, clear: true })).toBe(true);
        expect(isActionPending({ ...idlePending, cancelHandoff: true })).toBe(true);
    });

    it("folds handoff mutation pending into the single actionPending guard", () => {
        expect(isActionPending({ ...idlePending, handoff: true })).toBe(true);
        expect(isDiscoveryActionPending({ ...idlePending, handoff: true }, false)).toBe(true);
        expect(isDiscoveryActionPending(idlePending, true)).toBe(true);
        expect(isDiscoveryActionPending(idlePending, false)).toBe(false);
    });

    it("treats in-flight or server handoff as active", () => {
        expect(isHandoffActive(false, undefined)).toBe(false);
        expect(isHandoffActive(true, undefined)).toBe(true);
        expect(isHandoffActive(false, { isBrowserHandoffInProgress: true })).toBe(true);
    });
});

describe("discovery error surfaces", () => {
    it("prioritizes mutation errors and runtime terminal errors", () => {
        expect(
            deriveActionError({
                startError: "bad url",
                phase: "error",
                lastError: "boom",
            }),
        ).toBe("bad url");
        expect(
            deriveActionError({
                continueError: "provide_state requires auth-state.json",
                phase: "error",
                lastError: "boom",
            }),
        ).toBe("provide_state requires auth-state.json");
        expect(
            deriveActionError({
                phase: "error",
                lastError: "Discovery crashed",
            }),
        ).toBe("Discovery crashed");
    });

    it("surfaces query failures independently", () => {
        expect(
            deriveQueryError({
                flags: { runtime: true, stats: false, pages: false },
                runtimeMessage: "offline",
            }),
        ).toBe("Runtime query failed: offline");
        expect(
            deriveQueryError({
                flags: { runtime: false, stats: true, pages: false },
                statsMessage: "db locked",
            }),
        ).toBe("Stats query failed: db locked");
    });

    it("preserves provide_state auth errors verbatim", () => {
        const message = "provide_state resolution lacks usable auth storage state";
        expect(formatProvideStateError(message)).toBe(message);
    });
});

describe("discovery completion banner", () => {
    it("shows until dismissed", () => {
        expect(shouldShowCompletionBanner("max pages reached", false)).toBe(true);
        expect(shouldShowCompletionBanner("max pages reached", true)).toBe(false);
        expect(shouldShowCompletionBanner(undefined, false)).toBe(false);
    });
});

describe("discovery form helpers", () => {
    it("parses optional positive integers for crawl limits", () => {
        expect(parseOptionalPositiveInt("100")).toBe(100);
        expect(parseOptionalPositiveInt("")).toBeUndefined();
        expect(parseOptionalPositiveInt("-1")).toBeUndefined();
        expect(parseOptionalPositiveInt("abc")).toBeUndefined();
    });

    it("accepts only http(s) urls for safe links", () => {
        expect(safeHttpUrl("https://example.com/path")).toBe("https://example.com/path");
        expect(safeHttpUrl("ftp://example.com")).toBeNull();
        expect(safeHttpUrl("not-a-url")).toBeNull();
    });
});

describe("generate-test handoff", () => {
    it("builds a toast that names the drafted spec", () => {
        const url = "https://example.com/login";
        expect(buildGenerateTestToast(url)).toBe(`Drafting a smoke spec: ${url}`);
    });

    it("keeps the handoff delay constant for navigation UX", () => {
        expect(GENERATE_TEST_HANDOFF_MS).toBe(600);
    });
});
