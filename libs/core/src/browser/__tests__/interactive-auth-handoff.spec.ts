import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectAuthState } from "../../config/auth-state";
import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import {
    captureStorageBaseline,
    detectAuthLoginCompletion,
    detectHandoffCompletion,
    detectMaterialChange,
    HANDOFF_POLL_INTERVAL_MS,
    HANDOFF_STABILITY_POLLS,
    HandoffBlockerResolutionError,
    type PlaywrightStorageState,
    resolveHandoffBlockers,
    runInteractiveAuthHandoff,
    type StorageBaseline,
    snapshotStorageKey,
} from "../interactive-auth-handoff";

const mockPage = vi.hoisted(() => ({
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => "https://app.example.com/login"),
}));

const mockContext = vi.hoisted(() => ({
    storageState: vi.fn(),
    newPage: vi.fn(),
}));

const mockBrowser = vi.hoisted(() => {
    let disconnectHandler: (() => void) | null = null;
    return {
        triggerDisconnect: () => disconnectHandler?.(),
        once: vi.fn((event: string, handler: () => void) => {
            if (event === "disconnected") disconnectHandler = handler;
        }),
        close: vi.fn(async () => undefined),
        newContext: vi.fn(),
    };
});

vi.mock("../playwright-loader", () => ({
    loadPlaywrightChromium: () => ({
        launch: vi.fn(async () => mockBrowser),
    }),
}));

function emptyState(): PlaywrightStorageState {
    return { cookies: [], origins: [] };
}

function stateWithCookie(name: string, domain = "app.example.com"): PlaywrightStorageState {
    return {
        cookies: [
            {
                name,
                value: "v",
                domain,
                path: "/",
                expires: -1,
                httpOnly: false,
                secure: true,
                sameSite: "Lax",
            },
        ],
        origins: [],
    };
}

/** The handoff registers its `disconnected` listener several awaits into startup. */
async function waitForDisconnectHandler(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
        if (mockBrowser.once.mock.calls.some(([event]) => event === "disconnected")) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("disconnect handler was never registered");
}

function baselineFrom(state: PlaywrightStorageState, initialUrl: string): StorageBaseline {
    return {
        cookieKeys: new Set(state.cookies.map((c) => `${c.domain}\u0000${c.path}\u0000${c.name}`)),
        originKeys: new Set(
            state.origins.flatMap((o) =>
                (o.localStorage ?? []).map((item) => `${o.origin}\u0000${item.name}`),
            ),
        ),
        initialUrl,
    };
}

describe("interactive-auth-handoff detection", () => {
    it("detectMaterialChange flags new cookies, storage, and login redirects", () => {
        const baseline = baselineFrom(emptyState(), "https://app.example.com/login");
        expect(
            detectMaterialChange(
                baseline,
                stateWithCookie("session"),
                "https://app.example.com/login",
            ),
        ).toBe(true);
        expect(
            detectMaterialChange(baseline, emptyState(), "https://app.example.com/dashboard"),
        ).toBe(true);
    });

    it("detectAuthLoginCompletion ignores incidental cookies while still on login", () => {
        const baseline = baselineFrom(emptyState(), "https://app.example.com/login");
        expect(
            detectAuthLoginCompletion(
                baseline,
                stateWithCookie("_csrf"),
                "https://app.example.com/login",
            ),
        ).toBe(false);
    });

    it("detectAuthLoginCompletion accepts cred-bearing change after leaving login", () => {
        const baseline = baselineFrom(emptyState(), "https://app.example.com/login");
        expect(
            detectAuthLoginCompletion(
                baseline,
                stateWithCookie("session"),
                "https://app.example.com/dashboard",
            ),
        ).toBe(true);
    });

    it("detectHandoffCompletion applies auth stability only for auth_required", () => {
        const baseline = baselineFrom(emptyState(), "https://app.example.com/login");
        const changedOnLogin = stateWithCookie("_csrf");
        expect(
            detectHandoffCompletion(
                baseline,
                changedOnLogin,
                "https://app.example.com/login",
                "auth_required",
            ),
        ).toBe(false);
        expect(
            detectHandoffCompletion(
                baseline,
                changedOnLogin,
                "https://app.example.com/login",
                "captcha",
            ),
        ).toBe(true);
    });

    it("snapshotStorageKey is stable for identical state", () => {
        const state = stateWithCookie("a");
        const key = snapshotStorageKey(state, "https://app.example.com/");
        expect(snapshotStorageKey(state, "https://app.example.com/")).toBe(key);
    });
});

describe("interactive-auth-handoff orchestration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.storageState.mockReset();
        mockContext.newPage.mockResolvedValue(mockPage);
        mockBrowser.newContext.mockResolvedValue(mockContext);
        mockBrowser.once.mockClear();
        mockPage.url.mockReturnValue("https://app.example.com/login");
        mockPage.goto.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("completes via manual adapter without waiting for stability polls", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-manual-"));
        mockContext.storageState.mockResolvedValue(stateWithCookie("session"));

        let resolveManual: (() => void) | undefined;
        const manualPromise = new Promise<void>((resolve) => {
            resolveManual = resolve;
        });

        const runPromise = runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/login",
            pollIntervalMs: 50_000,
            createManualCompletionWatcher: () => ({
                promise: manualPromise,
                cancel: vi.fn(),
            }),
            blockerResolution: { kind: "auth_command" },
        });

        await Promise.resolve();
        resolveManual?.();
        const result = await runPromise;
        expect(result.reason).toBe("manual");
        expect(result.cookies).toBe(1);
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("times out when no completion signal arrives", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-timeout-"));
        mockContext.storageState.mockResolvedValue(stateWithCookie("session"));

        const result = await runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/login",
            timeoutMs: 20,
            pollIntervalMs: HANDOFF_POLL_INTERVAL_MS,
        });

        expect(result.reason).toBe("timeout");
        expect(result.cookies).toBe(1);
        expect(result.persisted).toBe(false);
        expect(fs.existsSync(path.join(projectPath, ".raiken", "auth-state.json"))).toBe(false);
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("leaves a previously saved auth state intact when the browser closes early", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-closed-"));
        const statePath = path.join(projectPath, ".raiken", "auth-state.json");
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(stateWithCookie("previous-session")));
        mockContext.storageState.mockResolvedValue(stateWithCookie("half-finished"));

        const runPromise = runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/login",
            pollIntervalMs: 50_000,
            blockerResolution: { kind: "auth_command" },
        });
        await waitForDisconnectHandler();
        mockBrowser.triggerDisconnect();

        const result = await runPromise;
        expect(result.reason).toBe("browser-closed");
        expect(result.persisted).toBe(false);
        expect(result.blockersResolved).toBe(0);
        const onDisk = JSON.parse(fs.readFileSync(statePath, "utf-8")) as PlaywrightStorageState;
        expect(onDisk.cookies[0]?.name).toBe("previous-session");
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("aborts promptly when the signal is already aborted", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-abort-"));
        mockContext.storageState.mockResolvedValue(stateWithCookie("session"));
        const controller = new AbortController();
        controller.abort();

        const result = await runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/login",
            signal: controller.signal,
            pollIntervalMs: 50_000,
        });

        expect(result.reason).toBe("abort");
        expect(result.cookies).toBe(1);
        expect(result.persisted).toBe(false);
        expect(fs.existsSync(path.join(projectPath, ".raiken", "auth-state.json"))).toBe(false);
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("auto-completes after stability polls when auth login is detected", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-auto-"));
        const sessionState = stateWithCookie("session");

        mockContext.storageState
            .mockResolvedValueOnce(emptyState())
            .mockResolvedValueOnce(emptyState())
            .mockResolvedValueOnce(sessionState)
            .mockResolvedValue(sessionState);
        mockPage.url
            .mockReturnValueOnce("https://app.example.com/login")
            .mockReturnValueOnce("https://app.example.com/dashboard")
            .mockReturnValue("https://app.example.com/dashboard");

        const result = await runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/login",
            pollIntervalMs: 5,
            stabilityPolls: HANDOFF_STABILITY_POLLS,
            category: "auth_required",
        });

        expect(result.reason).toBe("auto");
        expect(result.cookies).toBe(1);
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("writes validated atomic storage state to the configured destination", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-write-"));
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ auth: { storageStatePath: "e2e/.auth/user.json" } }),
        );
        mockContext.storageState.mockResolvedValue(stateWithCookie("session"));

        let finishManual: (() => void) | undefined;
        let manualRequested = false;
        await runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/",
            pollIntervalMs: 1,
            createManualCompletionWatcher: () => ({
                promise: new Promise<void>((resolve) => {
                    finishManual = resolve;
                }),
                cancel: vi.fn(),
            }),
            onProgress: () => {
                if (!manualRequested && finishManual) {
                    manualRequested = true;
                    finishManual();
                }
            },
            blockerResolution: { kind: "auth_command" },
        });

        const dest = path.join(projectPath, "e2e", ".auth", "user.json");
        const inspection = inspectAuthState(dest);
        expect(inspection.status).toBe("valid");
        expect(inspection.cookieCount).toBe(1);
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("returns blockerResolutionWarning when DB resolution fails after state is saved", async () => {
        const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-blocker-warn-"));
        const db = new CodeGraphDB(projectPath);
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
        siteDb.saveAuthBlocker({
            projectPath,
            url: "https://app.example.com/login",
            blockerType: "login_form",
            detectedElements: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });
        db.close();

        mockContext.storageState.mockResolvedValue(stateWithCookie("session"));
        const markSpy = vi
            .spyOn(SiteKnowledgeDB.prototype, "markBlockerResolved")
            .mockImplementation(() => {
                throw new Error("database locked");
            });

        let finishManual: (() => void) | undefined;
        let manualRequested = false;
        const result = await runInteractiveAuthHandoff({
            projectPath,
            url: "https://app.example.com/",
            pollIntervalMs: 1,
            createManualCompletionWatcher: () => ({
                promise: new Promise<void>((resolve) => {
                    finishManual = resolve;
                }),
                cancel: vi.fn(),
            }),
            onProgress: () => {
                if (!manualRequested && finishManual) {
                    manualRequested = true;
                    finishManual();
                }
            },
            blockerResolution: { kind: "auth_command" },
        });

        expect(result.blockerResolutionWarning).toContain("blocker resolution failed");
        expect(result.cookies).toBe(1);
        markSpy.mockRestore();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });
});

describe("resolveHandoffBlockers", () => {
    let projectPath: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-handoff-blockers-"));
        db = new CodeGraphDB(projectPath);
        siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        db.close();
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("auth_command resolves only auth_required via legacy provide_state", () => {
        const authId = siteDb.saveAuthBlocker({
            projectPath,
            url: "http://localhost/login",
            blockerType: "login_form",
            detectedElements: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });
        const captchaId = siteDb.saveBlocker({
            projectPath,
            url: "http://localhost/captcha",
            category: "captcha",
            severity: "pause",
            detectorId: "manual:captcha",
            detectedElements: null,
            evidenceJson: null,
            screenshotPath: null,
            resolution: null,
            resolvedVia: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });

        const touched = resolveHandoffBlockers(projectPath, {
            storageStatePath: "/tmp/auth-state.json",
            strategy: { kind: "auth_command" },
        });

        expect(touched).toBe(1);
        const authRow = siteDb.getBlocker(authId);
        expect(authRow?.resolution).toBe("provide_state");
        expect(authRow?.resolvedVia).toBe("legacy_storage_state");
        expect(siteDb.getBlocker(captchaId)?.resolvedAt).toBeNull();
    });

    it("dashboard_handoff records handoff metadata and resolvedVia", () => {
        const captchaId = siteDb.saveBlocker({
            projectPath,
            url: "http://localhost/captcha",
            category: "captcha",
            severity: "pause",
            detectorId: "manual:captcha",
            detectedElements: null,
            evidenceJson: null,
            screenshotPath: null,
            resolution: null,
            resolvedVia: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });

        const touched = resolveHandoffBlockers(projectPath, {
            storageStatePath: "/tmp/handoff.json",
            strategy: {
                kind: "dashboard_handoff",
                blockerId: captchaId,
                category: "captcha",
                resolvedVia: "dashboard_handoff",
            },
        });

        expect(touched).toBe(1);
        const row = siteDb.getBlocker(captchaId);
        expect(row?.resolution).toBe("handoff");
        expect(row?.resolvedVia).toBe("dashboard_handoff");
        expect(row?.storageStatePath).toBe("/tmp/handoff.json");
    });

    it("throws HandoffBlockerResolutionError instead of swallowing DB failures", () => {
        siteDb.saveAuthBlocker({
            projectPath,
            url: "http://localhost/login",
            blockerType: "login_form",
            detectedElements: null,
            resolvedAt: null,
            storageStatePath: null,
            discoveredAt: Date.now(),
        });
        const markSpy = vi
            .spyOn(SiteKnowledgeDB.prototype, "markBlockerResolved")
            .mockImplementation(() => {
                throw new Error("database locked");
            });

        expect(() =>
            resolveHandoffBlockers(projectPath, {
                storageStatePath: "/tmp/handoff.json",
                strategy: { kind: "auth_command" },
            }),
        ).toThrow(HandoffBlockerResolutionError);

        markSpy.mockRestore();
    });
});

describe("captureStorageBaseline", () => {
    it("returns empty sets when storageState throws", async () => {
        mockContext.storageState.mockRejectedValue(new Error("closed"));
        mockPage.url.mockReturnValue("about:blank");
        const baseline = await captureStorageBaseline(
            mockContext as unknown as import("playwright").BrowserContext,
            mockPage as unknown as import("playwright").Page,
        );
        expect(baseline.cookieKeys.size).toBe(0);
        expect(baseline.initialUrl).toBe("about:blank");
    });
});
