import { afterEach, describe, expect, it, vi } from "vitest";

// The module wraps console.warn at import time, binding whatever warn is in
// place as the passthrough. Stub warn first, then import, and assert what
// reaches the stub.

describe("upstream-warnings console filter", () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    async function importWithStubbedWarn() {
        const passthrough = vi.fn();
        vi.stubGlobal("console", { ...console, warn: passthrough });
        vi.resetModules();
        await import("../upstream-warnings");
        return passthrough;
    }

    it("drops the baseline-browser-mapping staleness nag", async () => {
        const passthrough = await importWithStubbedWarn();
        console.warn(
            "[baseline-browser-mapping] The data in this module is over two months old. …",
        );
        expect(passthrough).not.toHaveBeenCalled();
    });

    it("passes other warnings through", async () => {
        const passthrough = await importWithStubbedWarn();
        console.warn("[something-else] real warning");
        expect(passthrough).toHaveBeenCalledWith("[something-else] real warning");
    });

    it("matches on the prefix only, not substrings elsewhere", async () => {
        const passthrough = await importWithStubbedWarn();
        console.warn("note: see [baseline-browser-mapping] for details");
        expect(passthrough).toHaveBeenCalled();
    });
});
