import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type CorrelationContext,
    correlationFields,
    runWithCorrelationContext,
} from "../../../observability/context";

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

function mockDiscovery(start: () => Promise<void>) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        start: vi.fn(start),
        close: vi.fn(async () => undefined),
    });
}

describe("detached discovery correlation", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-disc-detached-"));
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it("retains merged correlation after caller HTTP scope exits", async () => {
        let correlationDuringRun: CorrelationContext | undefined;
        const discovery = mockDiscovery(async () => {
            discovery.emit("session_started", {
                type: "session_started",
                data: { sessionId: 88 },
                timestamp: Date.now(),
            });
            correlationDuringRun = correlationFields();
        });
        vi.mocked(createSiteDiscovery).mockReturnValue(discovery as never);

        let detachedPromise: Promise<void> | undefined;
        await runWithCorrelationContext(
            { correlationId: "caller-req-a", projectPath, requestId: "req-1" },
            async () => {
                const launched = await launchDiscoveryExecution(
                    projectPath,
                    { startUrl: "https://example.test" },
                    "detached",
                );
                detachedPromise = launched.promise;
            },
        );

        expect(correlationFields()).toEqual({});
        await detachedPromise;
        expect(correlationDuringRun).toMatchObject({
            correlationId: "caller-req-a",
            requestId: "req-1",
            operationId: expect.stringMatching(/^discovery-/),
            discoverySessionId: "88",
        });
    });

    it("isolates parallel detached discovery operations", async () => {
        const captured: CorrelationContext[] = [];
        let call = 0;
        vi.mocked(createSiteDiscovery).mockImplementation(() => {
            const id = ++call;
            return mockDiscovery(async () => {
                captured.push({ ...correlationFields() });
                await new Promise((resolve) => setTimeout(resolve, id === 1 ? 20 : 5));
            }) as never;
        });

        const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-disc-a-"));
        const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-disc-b-"));
        fs.mkdirSync(path.join(projectA, ".raiken"), { recursive: true });
        fs.mkdirSync(path.join(projectB, ".raiken"), { recursive: true });

        try {
            let promiseA: Promise<void> | undefined;
            let promiseB: Promise<void> | undefined;
            await runWithCorrelationContext(
                { correlationId: "req-left", projectPath: projectA },
                async () => {
                    promiseA = (
                        await launchDiscoveryExecution(
                            projectA,
                            { startUrl: "https://a.test" },
                            "detached",
                        )
                    ).promise;
                },
            );
            await runWithCorrelationContext(
                { correlationId: "req-right", projectPath: projectB },
                async () => {
                    promiseB = (
                        await launchDiscoveryExecution(
                            projectB,
                            { startUrl: "https://b.test" },
                            "detached",
                        )
                    ).promise;
                },
            );

            await Promise.all([promiseA, promiseB]);
            expect(captured).toHaveLength(2);
            expect(captured.map((entry) => entry.correlationId).sort()).toEqual([
                "req-left",
                "req-right",
            ]);
            expect(captured[0]?.projectRef).not.toBe(captured[1]?.projectRef);
        } finally {
            fs.rmSync(projectA, { recursive: true, force: true });
            fs.rmSync(projectB, { recursive: true, force: true });
        }
    });
});
