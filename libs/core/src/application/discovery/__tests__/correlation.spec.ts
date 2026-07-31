import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correlationFields } from "../../../observability/context";

vi.mock("../../../site-discovery/discovery-config", () => ({
    createSiteDiscovery: vi.fn(),
    resolveSiteDiscoveryOptions: vi.fn(() => ({
        startUrl: "https://example.test",
        maxPages: 10,
        maxDepth: 2,
    })),
}));

vi.mock("../state-hydrator", () => ({
    hydrateDiscoveryStateCore: vi.fn(async () => undefined),
}));
vi.mock("../listeners", () => ({
    attachDiscoveryRuntimeListeners: vi.fn(),
    attachUxListeners: vi.fn(),
    attachBackgroundStateListeners: vi.fn(),
}));
vi.mock("../registry", () => ({
    getDiscoveryProjectRuntime: vi.fn(() => ({ abortInFlight: false, background: undefined })),
}));
vi.mock("../state", () => ({
    discoveryJobStore: { has: vi.fn(() => false), set: vi.fn(), delete: vi.fn() },
    patchDiscoveryState: vi.fn(),
    pushDiscoveryEvent: vi.fn(),
}));

import { createSiteDiscovery } from "../../../site-discovery/discovery-config";
import { launchDiscoveryExecution } from "../execution";

describe("discovery correlation propagation", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-corr-"));
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it("binds discoverySessionId from session_started without replacing operationId", async () => {
        const emitter = new EventEmitter();
        const discovery = Object.assign(emitter, {
            start: vi.fn(async () => {
                emitter.emit("session_started", {
                    type: "session_started",
                    data: { sessionId: 77 },
                    timestamp: Date.now(),
                });
            }),
            close: vi.fn(async () => undefined),
        });
        vi.mocked(createSiteDiscovery).mockReturnValue(discovery as never);

        const { promise } = await launchDiscoveryExecution(
            projectPath,
            { startUrl: "https://example.test" },
            "blocking",
        );
        await promise;

        expect(correlationFields()).toEqual({});
    });
});
