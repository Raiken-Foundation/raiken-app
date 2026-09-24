/**
 * Dashboard manual-handoff integration spec.
 *
 * Uses a mocked Playwright browser with a real SQLite project DB to prove
 * dashboard handoffs save validated auth state, clear matching blockers with
 * resolvedVia metadata, and surface blocker-resolution failures without
 * pretending the blockers were cleared.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandoffBlockerResolutionError } from "../../browser/interactive-auth-handoff";
import { inspectAuthState, resolveAuthStorageStateDestination } from "../../config/auth-state";
import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../db";
import { runManualHandoff } from "../manual-handoff";

const mockPage = vi.hoisted(() => ({
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => "https://app.example.com/dashboard"),
}));

const mockContext = vi.hoisted(() => ({
    storageState: vi.fn(),
    newPage: vi.fn(),
}));

const mockBrowser = vi.hoisted(() => ({
    once: vi.fn(),
    close: vi.fn(async () => undefined),
    newContext: vi.fn(),
}));

vi.mock("../../browser/playwright-loader", () => ({
    loadPlaywrightChromium: () => ({
        launch: vi.fn(async () => mockBrowser),
    }),
}));

function sessionState() {
    return {
        cookies: [
            {
                name: "session",
                value: "token",
                domain: "app.example.com",
                path: "/",
                expires: -1,
                httpOnly: true,
                secure: true,
                sameSite: "Lax" as const,
            },
        ],
        origins: [],
    };
}

describe("runManualHandoff dashboard integration", () => {
    let projectPath: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;
    let blockerId: number;
    let storageStatePath: string;

    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.storageState.mockResolvedValue(sessionState());
        mockContext.newPage.mockResolvedValue(mockPage);
        mockBrowser.newContext.mockResolvedValue(mockContext);
        mockPage.url.mockReturnValue("https://app.example.com/dashboard");

        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-manual-handoff-int-"));
        projectPath = fs.realpathSync(projectPath);
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
        storageStatePath = resolveAuthStorageStateDestination(projectPath);
        db = new CodeGraphDB(projectPath);
        siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
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
    });

    afterEach(() => {
        vi.restoreAllMocks();
        db.close();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("saves valid state, clears matching blocker with resolvedVia, and emits resume-visible resolution", async () => {
        const progress: Array<{ reason?: string; blockerResolutionWarning?: string }> = [];

        mockContext.storageState
            .mockResolvedValueOnce({ cookies: [], origins: [] })
            .mockResolvedValueOnce({ cookies: [], origins: [] })
            .mockResolvedValue(sessionState());
        mockPage.url
            .mockReturnValueOnce("https://app.example.com/login")
            .mockReturnValue("https://app.example.com/dashboard");

        const result = await runManualHandoff({
            projectPath,
            url: "https://app.example.com/login",
            blockerId,
            category: "auth_required",
            pollIntervalMs: 5,
            stabilityPolls: 2,
            onProgress: (snapshot) => progress.push(snapshot),
        });

        expect(result.reason).toBe("auto");
        expect(result.blockersResolved).toBe(1);
        expect(result.blockerResolutionWarning).toBeUndefined();

        const inspection = inspectAuthState(storageStatePath);
        expect(inspection.status).toBe("valid");
        expect(inspection.cookieCount).toBe(1);

        const row = siteDb.getBlocker(blockerId);
        expect(row?.resolution).toBe("handoff");
        expect(row?.resolvedVia).toBe("dashboard_handoff");
        expect(row?.storageStatePath).toBe(storageStatePath);
        expect(row?.resolvedAt).not.toBeNull();
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);

        const doneProgress = progress.find((entry) => entry.reason === "auto");
        expect(doneProgress).toBeDefined();
        expect(doneProgress?.blockerResolutionWarning).toBeUndefined();
    });

    it("preserves abort reason and does not claim blockers were resolved", async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runManualHandoff({
            projectPath,
            url: "https://app.example.com/login",
            blockerId,
            signal: controller.signal,
            pollIntervalMs: 50_000,
        });

        expect(result.reason).toBe("abort");
        expect(result.blockersResolved).toBe(0);
        expect(siteDb.getBlocker(blockerId)?.resolvedAt).toBeNull();
    });

    it("surfaces blocker-resolution failure while keeping saved auth state", async () => {
        const markSpy = vi
            .spyOn(SiteKnowledgeDB.prototype, "markBlockerResolved")
            .mockImplementation(() => {
                throw new Error("database locked");
            });

        mockContext.storageState
            .mockResolvedValueOnce({ cookies: [], origins: [] })
            .mockResolvedValueOnce({ cookies: [], origins: [] })
            .mockResolvedValue(sessionState());
        mockPage.url
            .mockReturnValueOnce("https://app.example.com/login")
            .mockReturnValue("https://app.example.com/dashboard");

        const result = await runManualHandoff({
            projectPath,
            url: "https://app.example.com/login",
            blockerId,
            pollIntervalMs: 5,
            stabilityPolls: 2,
        });

        expect(result.reason).toBe("auto");
        expect(result.blockersResolved).toBe(0);
        expect(result.blockerResolutionWarning).toContain("blocker resolution failed");
        expect(result.blockerResolutionWarning).toContain(storageStatePath);

        const inspection = inspectAuthState(storageStatePath);
        expect(inspection.status).toBe("valid");
        expect(siteDb.getBlocker(blockerId)?.resolvedAt).toBeNull();

        markSpy.mockRestore();
    });

    it("throws HandoffBlockerResolutionError from resolveHandoffBlockers on DB failure", async () => {
        const markSpy = vi
            .spyOn(SiteKnowledgeDB.prototype, "markBlockerResolved")
            .mockImplementation(() => {
                throw new Error("database locked");
            });

        const { resolveHandoffBlockers } = await import("../../browser/interactive-auth-handoff");
        expect(() =>
            resolveHandoffBlockers(projectPath, {
                storageStatePath,
                strategy: {
                    kind: "dashboard_handoff",
                    blockerId,
                    category: "auth_required",
                    resolvedVia: "dashboard_handoff",
                },
            }),
        ).toThrow(HandoffBlockerResolutionError);

        markSpy.mockRestore();
    });
});
