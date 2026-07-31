import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../../site-discovery/db";
import { DiscoveryApplication } from "../application";
import {
    discoveryProjectRegistrySizeForTests,
    isBrowserHandoffInProgress,
    resetDiscoveryProjectRegistryForTests,
} from "../registry";

const handoffRun = vi.hoisted(() => vi.fn());

vi.mock("../../../site-discovery/manual-handoff", () => ({
    runManualHandoff: (...args: unknown[]) => handoffRun(...args),
}));

vi.mock("../../../operations/project-operation", () => ({
    acquireProjectOperation: vi.fn(async () => ({
        release: vi.fn(async () => undefined),
    })),
}));

describe("DiscoveryProjectRuntime registry seam", () => {
    afterEach(() => {
        resetDiscoveryProjectRegistryForTests();
    });

    it("creates one runtime per canonical project path", async () => {
        const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-disc-registry-"));
        const app = new DiscoveryApplication(project);
        expect(discoveryProjectRegistrySizeForTests()).toBe(1);
        app.dispose();
        expect(discoveryProjectRegistrySizeForTests()).toBe(0);
        await fs.rm(project, { recursive: true, force: true });
    });
});

describe("DiscoveryApplication browser handoff cancel", () => {
    let projectPath: string;
    let blockerId: number;

    beforeEach(async () => {
        handoffRun.mockReset();
        projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-handoff-cancel-"));
        await fs.mkdir(path.join(projectPath, ".raiken"), { recursive: true });

        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            blockerId = siteDb.saveBlocker({
                projectPath,
                url: "https://app.example.com/login",
                category: "auth_required",
                severity: "pause",
                detectorId: "auth:login_form",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });
        } finally {
            db.close();
        }
    });

    afterEach(async () => {
        resetDiscoveryProjectRegistryForTests();
        await fs.rm(projectPath, { recursive: true, force: true });
    });

    it("request → cancel yields abort reason and does not resolve blockers", async () => {
        let capturedSignal: AbortSignal | undefined;
        handoffRun.mockImplementation(async (options: { signal?: AbortSignal }) => {
            capturedSignal = options.signal;
            await new Promise<void>((resolve) => {
                options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return {
                storageStatePath: path.join(projectPath, ".raiken", "auth-state.json"),
                cookies: 0,
                origins: 0,
                reason: "abort" as const,
                blockersResolved: 0,
            };
        });

        const app = new DiscoveryApplication(projectPath);
        const handoffPromise = app.requestBrowserHandoff(
            { blockerId, category: "auth_required" },
            (p) => path.join(p, ".raiken", "auth-state.json"),
        );

        await vi.waitFor(() => expect(isBrowserHandoffInProgress(projectPath)).toBe(true));
        expect(capturedSignal?.aborted).toBe(false);

        const cancelResult = app.cancelBrowserHandoff();
        expect(cancelResult.success).toBe(true);

        const handoffResult = await handoffPromise;
        expect(handoffResult.success).toBe(false);
        expect(handoffResult.reason).toBe("abort");
        expect(handoffResult.blockersResolved).toBe(0);

        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const unresolved = siteDb.getUnresolvedBlockers();
            expect(unresolved.some((b) => b.id === blockerId)).toBe(true);
            const blocker = siteDb.getBlocker(blockerId);
            expect(blocker?.resolution).toBeNull();
        } finally {
            db.close();
        }

        expect(isBrowserHandoffInProgress(projectPath)).toBe(false);
    });

    it("cancel without active handoff returns structured failure", () => {
        const app = new DiscoveryApplication(projectPath);
        const result = app.cancelBrowserHandoff();
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no browser handoff/i);
    });
});
