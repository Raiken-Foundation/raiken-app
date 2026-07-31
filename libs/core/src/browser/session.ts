/**
 * BrowserSession - Persistent Playwright Browser Session
 *
 * Manages a single browser instance that stays open across tool calls.
 * Enables navigation, interaction, and page capture without browser restarts.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import {
    describeAuthStateProblem,
    inspectAuthState,
    writeValidatedAuthState,
} from "../config/auth-state";
import { loadBrowserConfig } from "../config/load";
import type { DOMContext, PagePerformance } from "./dom-capture";
import { collectResponseTimings, DomSnapshotBuilder } from "./session/dom-snapshot-builder";
import { escapeCssId, InteractionStrategies } from "./session/interaction-strategies";
import {
    BrowserActionError,
    LocatorResolver,
    type SelectorMemoryHooks,
} from "./session/locator-resolver";
import {
    closeRegisteredBrowserSessions,
    getOrCreateRegisteredBrowserSession,
    resetRegisteredBrowserSessions,
} from "./session/registry-store";
import { buildFieldSelector, classifySelector, type SelectorKind } from "./session/selector-utils";

export { BrowserActionError, buildFieldSelector, classifySelector };
export type { SelectorKind };

/**
 * Sink for selector success/failure, so the session can record outcomes
 * without coupling to a specific persistence layer (AgentMemory, CodeGraphDB).
 */
export interface SelectorMemory {
    recordSuccess(element: string, selector: string, kind: SelectorKind): void;
    recordFailure(element: string, selector: string, kind: SelectorKind): void;
}

/**
 * Options for starting the browser session
 */
export interface BrowserSessionOptions {
    /** Run in headless mode (default: true) */
    headless?: boolean;
    /** Path to auth state file */
    storageStatePath?: string;
    /** Viewport width (default: 1280) */
    viewportWidth?: number;
    /** Viewport height (default: 720) */
    viewportHeight?: number;
    /** Default timeout in ms (default: 30000) */
    timeout?: number;
    /** Engine to launch (default: the project's `browser.defaultBrowser`) */
    browserName?: "chromium" | "firefox" | "webkit";
}

const SESSION_DEFAULTS = {
    headless: true,
    viewportWidth: 1280,
    viewportHeight: 720,
    timeout: 30000,
} as const;

/**
 * Result of a page capture
 */
export interface PageCapture {
    url: string;
    title: string;
    domContext: DOMContext;
}

/**
 * BrowserSession singleton - manages a persistent browser instance
 */
export class BrowserSession {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private options: BrowserSessionOptions &
        Required<
            Pick<BrowserSessionOptions, "headless" | "viewportWidth" | "viewportHeight" | "timeout">
        >;
    private selectorMemory: SelectorMemory | null = null;
    private startPromise: Promise<void> | null = null;

    private lastNavigationMs?: number;
    private lastNetworkIdle?: boolean;
    private lastSlowResponses?: PagePerformance["slowResponses"];

    private locatorResolver: LocatorResolver;
    private domSnapshot: DomSnapshotBuilder;
    private interactions: InteractionStrategies;

    private readonly projectPath: string;
    /** Options the caller constructed the session with; these outrank config. */
    private readonly explicitOptions: BrowserSessionOptions;

    private constructor(projectPath: string, options: BrowserSessionOptions = {}) {
        this.projectPath = projectPath;
        this.explicitOptions = { ...options };
        this.options = { ...SESSION_DEFAULTS, ...options };

        const self = this;
        this.locatorResolver = new LocatorResolver({
            getPage: () => self.getActivePage(),
            getDefaultTimeout: () => self.options.timeout,
            get selectorMemory(): SelectorMemoryHooks | null {
                return self.selectorMemory;
            },
        });
        this.domSnapshot = new DomSnapshotBuilder({
            getPage: () => self.getActivePage(),
            getPerformanceSignals: () => ({
                lastNavigationMs: self.lastNavigationMs,
                lastNetworkIdle: self.lastNetworkIdle,
                lastSlowResponses: self.lastSlowResponses,
            }),
        });
        this.interactions = new InteractionStrategies({
            getPage: () => self.getActivePage(),
            actionTimeoutMs: () => self.actionTimeoutMs(),
            wait: (ms) => self.wait(ms),
            escapeCssId,
        });
    }

    /** @internal Used by the canonical-project browser registry. */
    static __create(projectPath: string, options?: BrowserSessionOptions): BrowserSession {
        return new BrowserSession(projectPath, options);
    }

    private getActivePage(): Page {
        if (!this.page) {
            throw new BrowserActionError(
                "access page",
                "session",
                new Error("Browser session has not been launched yet (call launch() first)"),
            );
        }
        return this.page;
    }

    private getActiveContext(): BrowserContext {
        if (!this.context) {
            throw new BrowserActionError(
                "access context",
                "session",
                new Error("Browser session has not been launched yet (call launch() first)"),
            );
        }
        return this.context;
    }

    static getInstance(projectPath: string): BrowserSession {
        return getOrCreateRegisteredBrowserSession(projectPath, BrowserSession.__create);
    }

    setSelectorMemory(memory: SelectorMemory | null): void {
        this.selectorMemory = memory;
    }

    isActive(): boolean {
        if (!this.browser || !this.page) return false;
        try {
            this.page.url();
            return true;
        } catch {
            return false;
        }
    }

    async start(options?: BrowserSessionOptions): Promise<void> {
        if (this.isActive()) {
            return;
        }

        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this.doStart(options);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    /**
     * The documented `browser` section of `raiken.config.json`. Read at launch
     * rather than construction so edits apply to the next session start.
     */
    private configuredDefaults(): BrowserSessionOptions {
        try {
            const browser = loadBrowserConfig(this.projectPath);
            return {
                browserName: browser.defaultBrowser,
                headless: browser.headless,
                timeout: browser.timeout,
            };
        } catch {
            // An unreadable config must not stop the browser from launching.
            return {};
        }
    }

    /** Navigation attempts allowed by the project's `browser.retries`. */
    private navigationAttempts(): number {
        try {
            return Math.max(1, loadBrowserConfig(this.projectPath).retries + 1);
        } catch {
            return 1;
        }
    }

    private async doStart(options?: BrowserSessionOptions): Promise<void> {
        if (this.browser) {
            await this.close();
        }

        // Precedence: start() options > constructor options > the project's
        // `browser` config > built-in defaults, with RAIKEN_HEADLESS as a final
        // escape hatch.
        const opts = {
            ...SESSION_DEFAULTS,
            ...this.configuredDefaults(),
            ...this.explicitOptions,
            ...options,
        };

        const envHeadless = process.env["RAIKEN_HEADLESS"]?.trim().toLowerCase();
        if (envHeadless === "0" || envHeadless === "false") {
            opts.headless = false;
        } else if (envHeadless === "1" || envHeadless === "true") {
            opts.headless = true;
        }

        this.options = opts;

        const playwright = await import("playwright");
        const engine = playwright[opts.browserName ?? "chromium"];
        this.browser = await engine.launch({ headless: opts.headless });

        try {
            const contextOptions: Parameters<Browser["newContext"]>[0] = {
                viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
            };

            if (opts.storageStatePath) {
                const inspection = inspectAuthState(opts.storageStatePath);
                if (inspection.status !== "valid") {
                    throw new Error(
                        describeAuthStateProblem(inspection) ?? "Auth state is not usable.",
                    );
                }
                contextOptions.storageState = opts.storageStatePath;
            }

            this.context = await this.browser.newContext(contextOptions);
            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(opts.timeout);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (error) {
                console.warn(
                    "Error closing browser (continuing):",
                    error instanceof Error ? error.message : error,
                );
            }
            this.browser = null;
            this.context = null;
            this.page = null;
        }
    }

    static async closeInstance(): Promise<void> {
        await closeRegisteredBrowserSessions();
    }

    static async reset(): Promise<void> {
        await resetRegisteredBrowserSessions();
    }

    // =========================================================================
    // Navigation
    // =========================================================================

    async navigate(url: string): Promise<DOMContext> {
        if (!this.isActive()) {
            await this.close();
            await this.start(this.options);
        }

        const navStart = Date.now();
        let stopCollecting = collectResponseTimings(this.page);
        const attempts = this.navigationAttempts();

        try {
            for (let attempt = 1; ; attempt++) {
                try {
                    await this.getActivePage().goto(url, {
                        waitUntil: "domcontentloaded",
                        timeout: this.options.timeout,
                    });
                    break;
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    if (msg.includes("has been closed") || msg.includes("Target closed")) {
                        stopCollecting();
                        await this.close();
                        await this.start(this.options);
                        stopCollecting = collectResponseTimings(this.page);
                        await this.getActivePage().goto(url, {
                            waitUntil: "domcontentloaded",
                            timeout: this.options.timeout,
                        });
                        break;
                    }
                    // `browser.retries` from raiken.config.json.
                    if (attempt >= attempts) throw new BrowserActionError("navigate", url, error);
                }
            }

            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } finally {
            this.lastSlowResponses = stopCollecting();
        }

        return this.captureCurrentPage();
    }

    async reload(): Promise<DOMContext> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = collectResponseTimings(this.page);
        try {
            await this.getActivePage().reload({ waitUntil: "domcontentloaded" });
            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("reload", this.getActivePage().url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }

        return this.captureCurrentPage();
    }

    async goBack(): Promise<DOMContext | null> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = collectResponseTimings(this.page);
        try {
            const response = await this.getActivePage().goBack({ waitUntil: "domcontentloaded" });
            if (!response) {
                return null;
            }
            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("goBack", this.getActivePage().url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }
        return this.captureCurrentPage();
    }

    async goForward(): Promise<DOMContext | null> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = collectResponseTimings(this.page);
        try {
            const response = await this.getActivePage().goForward({
                waitUntil: "domcontentloaded",
            });
            if (!response) {
                return null;
            }
            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("goForward", this.getActivePage().url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }
        return this.captureCurrentPage();
    }

    getCurrentUrl(): string {
        this.ensureActive();
        return this.getActivePage().url();
    }

    // =========================================================================
    // Interaction
    // =========================================================================

    private actionTimeoutMs(): number {
        const base = this.options.timeout ?? 30000;
        return Math.min(Math.max(base, 5000), 15000);
    }

    async click(selectors: string | string[]): Promise<void> {
        await this.locatorResolver.runWithSelectors("click", selectors, (loc) =>
            loc.click({ timeout: this.actionTimeoutMs() }),
        );
    }

    async fill(selectors: string | string[], value: string): Promise<void> {
        await this.locatorResolver.runWithSelectors("fill", selectors, (loc) =>
            this.interactions.fillField(loc, value),
        );
    }

    async type(selectors: string | string[], text: string): Promise<void> {
        await this.locatorResolver.runWithSelectors("type", selectors, (loc) =>
            loc.pressSequentially(text, { timeout: this.actionTimeoutMs() }),
        );
    }

    async press(key: string): Promise<void> {
        this.ensureActive();
        try {
            await this.getActivePage().keyboard.press(key);
        } catch (error) {
            throw new BrowserActionError("press", key, error);
        }
    }

    async selectOption(selectors: string | string[], value: string): Promise<void> {
        await this.locatorResolver.runWithSelectors("selectOption", selectors, (loc) =>
            this.interactions.selectField(loc, value),
        );
    }

    async check(selectors: string | string[]): Promise<void> {
        await this.locatorResolver.runWithSelectors("check", selectors, (loc) =>
            loc.check({ timeout: this.actionTimeoutMs() }),
        );
    }

    async uncheck(selectors: string | string[]): Promise<void> {
        await this.locatorResolver.runWithSelectors("uncheck", selectors, (loc) =>
            loc.uncheck({ timeout: this.actionTimeoutMs() }),
        );
    }

    async hover(selectors: string | string[]): Promise<void> {
        await this.locatorResolver.runWithSelectors("hover", selectors, (loc) =>
            loc.hover({ timeout: this.actionTimeoutMs() }),
        );
    }

    async focus(selectors: string | string[]): Promise<void> {
        await this.locatorResolver.runWithSelectors("focus", selectors, (loc) =>
            loc.focus({ timeout: this.actionTimeoutMs() }),
        );
    }

    // =========================================================================
    // Waiting
    // =========================================================================

    async waitForSelector(selectors: string | string[], timeout?: number): Promise<void> {
        this.ensureActive();
        await this.locatorResolver.waitForSelector(selectors, timeout);
    }

    async waitForNavigation(timeout?: number): Promise<void> {
        this.ensureActive();
        try {
            await this.getActivePage().waitForNavigation({
                timeout: timeout || this.options.timeout,
            });
        } catch (error) {
            throw new BrowserActionError("waitForNavigation", this.getActivePage().url(), error);
        }
    }

    async waitForNetworkIdle(timeout?: number): Promise<void> {
        this.ensureActive();
        await this.getActivePage().waitForLoadState("networkidle", { timeout: timeout || 5000 });
    }

    async settle(): Promise<boolean> {
        if (!this.isActive()) return false;
        const idle = await this.waitForIdle();
        await this.waitForContent();
        return idle;
    }

    async wait(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    // =========================================================================
    // State Capture
    // =========================================================================

    async captureCurrentPage(): Promise<DOMContext> {
        this.ensureActive();

        try {
            return await this.domSnapshot.capture();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("has been closed") || msg.includes("Target closed")) {
                if (this.context) {
                    const pages = this.context.pages();
                    if (pages.length > 0) {
                        this.page = pages[pages.length - 1];
                        return await this.domSnapshot.capture();
                    }
                }
            }
            throw new BrowserActionError(
                "captureCurrentPage",
                this.page?.url() || "unknown",
                error,
            );
        }
    }

    async screenshot(): Promise<Buffer> {
        this.ensureActive();
        return this.getActivePage().screenshot();
    }

    async discoverLinks(): Promise<
        Array<{
            text: string;
            href: string;
            isExternal: boolean;
            suggestedSelectors: string[];
        }>
    > {
        this.ensureActive();
        return this.domSnapshot.discoverLinks();
    }

    // =========================================================================
    // Auth State
    // =========================================================================

    async saveAuthState(path: string): Promise<void> {
        this.ensureActive();
        const state = await this.getActiveContext().storageState();
        writeValidatedAuthState(path, state);
    }

    async loadAuthState(path: string): Promise<void> {
        if (!this.browser) {
            throw new Error("Browser not started. Call start() first.");
        }
        const inspection = inspectAuthState(path);
        if (inspection.status !== "valid") {
            throw new Error(describeAuthStateProblem(inspection) ?? "Auth state is not usable.");
        }

        if (this.context) {
            await this.context.close();
        }

        this.context = await this.browser.newContext({
            viewport: { width: this.options.viewportWidth, height: this.options.viewportHeight },
            storageState: path,
        });

        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.options.timeout);
    }

    async hasBlockingOverlay(): Promise<boolean> {
        if (!this.isActive()) return false;
        try {
            const count = await this.getActivePage()
                .locator('[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]')
                .count();
            return count > 0;
        } catch {
            return false;
        }
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    private ensureActive(): void {
        if (!this.isActive()) {
            throw new Error("Browser session not active. Call start() first.");
        }
    }

    private async waitForIdle(): Promise<boolean> {
        try {
            await this.getActivePage().waitForLoadState("networkidle", { timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    }

    private async waitForContent(): Promise<void> {
        try {
            await this.getActivePage().waitForFunction(
                () => {
                    const sel =
                        'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
                    if (document.querySelector(sel)) return true;
                    return (document.body?.innerText || "").trim().length > 200;
                },
                { timeout: 4000 },
            );
        } catch {
            // Fail open: capture whatever is there rather than blocking the run.
        }
    }
}
