import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the handoff error-path guard (review finding,
 * interactive-auth-handoff.ts:361-377): any throw between browser launch
 * and the race setup (newContext, newPage, the caller-supplied
 * onBrowserReady hook) must close the browser — never leak a zombie
 * Chromium process per failed handoff.
 */

const closeMock = vi.fn(async () => {});

vi.mock("../playwright-loader", () => ({
    loadPlaywrightChromium: () => ({
        launch: async () => ({
            newContext: async () => {
                throw new Error("context creation failed");
            },
            once: () => {},
            close: closeMock,
        }),
    }),
}));

import { runInteractiveAuthHandoff } from "../interactive-auth-handoff";

describe("runInteractiveAuthHandoff error path", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-guard-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("closes the browser when context/page creation fails", async () => {
        closeMock.mockClear();

        await expect(
            runInteractiveAuthHandoff({
                projectPath,
                url: "http://localhost:9999",
            }),
        ).rejects.toThrow("context creation failed");

        expect(closeMock).toHaveBeenCalledTimes(1);
    });
});
