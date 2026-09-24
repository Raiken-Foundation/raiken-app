import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    acquireBrowserSessionLease,
    getOrCreateBrowserSession,
    releaseBrowserSessionLease,
    resetBrowserRegistry,
} from "../registry";
import { BrowserSession } from "../session";

afterEach(async () => {
    await resetBrowserRegistry();
});

describe("browser session registry", () => {
    it("returns one session per canonical project path", () => {
        const project = path.join(os.tmpdir(), "raiken-browser-a");
        const other = path.join(os.tmpdir(), "raiken-browser-b");

        const first = getOrCreateBrowserSession(project);
        const same = getOrCreateBrowserSession(path.join(project, "."));
        const second = getOrCreateBrowserSession(other);

        expect(first).toBe(same);
        expect(second).not.toBe(first);
        expect(BrowserSession.getInstance(project)).toBe(first);
    });

    it("keeps the browser open on a normal lease release", async () => {
        const project = path.join(os.tmpdir(), "raiken-browser-lease");
        const session = getOrCreateBrowserSession(project);
        const closeSpy = vi.spyOn(session, "close").mockResolvedValue(undefined);

        const lease = acquireBrowserSessionLease(project);
        await lease.release();

        expect(closeSpy).not.toHaveBeenCalled();
    });

    it("closes the browser when a lease is force-released or aborted", async () => {
        const project = path.join(os.tmpdir(), "raiken-browser-abort");
        const session = getOrCreateBrowserSession(project);
        const closeSpy = vi.spyOn(session, "close").mockResolvedValue(undefined);

        const controller = new AbortController();
        const lease = acquireBrowserSessionLease(project, controller.signal);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await lease.release();

        expect(closeSpy).toHaveBeenCalledTimes(1);

        closeSpy.mockClear();
        await releaseBrowserSessionLease(project, { forceClose: true });
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
