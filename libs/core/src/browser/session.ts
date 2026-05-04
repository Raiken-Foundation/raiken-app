/**
 * BrowserSession - Persistent Playwright Browser Session
 *
 * Manages a single browser instance that stays open across tool calls.
 * Enables navigation, interaction, and page capture without browser restarts.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import type { DOMContext, InteractiveElement, FormField, AccessibilityNode } from "./dom-capture";

export class BrowserActionError extends Error {
    readonly action: string;
    readonly target: string;
    override readonly cause: unknown;

    constructor(action: string, target: string, cause: unknown) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause);
        const shortMsg = causeMsg.length > 200 ? `${causeMsg.slice(0, 200)}...` : causeMsg;
        super(`Browser ${action} failed on "${target}": ${shortMsg}`);
        this.name = "BrowserActionError";
        this.action = action;
        this.target = target;
        this.cause = cause;
    }
}

/**
 * Type of selector, for selector memory classification.
 */
export type SelectorKind =
    | "data-testid"
    | "role"
    | "text"
    | "css"
    | "xpath"
    | "other";

/**
 * Sink for selector success/failure, so the session can record outcomes
 * without coupling to a specific persistence layer (AgentMemory, CodeGraphDB).
 *
 * `element` identifies the logical element being targeted (typically the first,
 * most-stable selector the caller offered). `selector` is the specific locator
 * that was tried. `kind` is a stable classification of the selector style.
 */
export interface SelectorMemory {
    recordSuccess(element: string, selector: string, kind: SelectorKind): void;
    recordFailure(element: string, selector: string, kind: SelectorKind): void;
}

/**
 * Classify a selector string into a stable kind so downstream analytics can
 * compare "how reliable is data-testid vs role vs text on this project?".
 */
export function classifySelector(selector: string): SelectorKind {
    const s = selector.trim();
    if (/^getByTestId\(/.test(s) || /data-testid=/.test(s)) return "data-testid";
    if (/^getByRole\(/.test(s) || /^role=/.test(s)) return "role";
    if (
        /^getByText\(/.test(s) ||
        /^getByLabel\(/.test(s) ||
        /^getByPlaceholder\(/.test(s) ||
        s.startsWith("text=") ||
        s.startsWith("label=") ||
        s.startsWith("placeholder=")
    ) {
        return "text";
    }
    if (s.startsWith("//") || s.startsWith("xpath=")) return "xpath";
    if (/^[#.\[]/.test(s) || /^[a-zA-Z]+(\[|\.|\s|$)/.test(s)) return "css";
    return "other";
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
}

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
    private static instance: BrowserSession | null = null;

    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private projectPath: string;
    private options: BrowserSessionOptions;
    private selectorMemory: SelectorMemory | null = null;

    private constructor(projectPath: string, options: BrowserSessionOptions = {}) {
        this.projectPath = projectPath;
        this.options = {
            headless: true,
            viewportWidth: 1280,
            viewportHeight: 720,
            timeout: 30000,
            ...options,
        };
    }

    /**
     * Get or create the browser session instance.
     * If the projectPath changes, the existing instance is updated
     * (the browser itself is shared; only the auth-state lookup path changes).
     */
    static getInstance(projectPath: string): BrowserSession {
        if (!BrowserSession.instance) {
            BrowserSession.instance = new BrowserSession(projectPath);
        } else if (BrowserSession.instance.projectPath !== projectPath) {
            BrowserSession.instance.projectPath = projectPath;
            BrowserSession.instance.selectorMemory = null;
        }
        return BrowserSession.instance;
    }

    /**
     * Attach a selector memory sink. The session will call it for every
     * selector attempt made through `runWithSelectors`/`waitForSelector`,
     * so persistent layers can track which selectors succeed or fail.
     *
     * Pass `null` to detach.
     */
    setSelectorMemory(memory: SelectorMemory | null): void {
        this.selectorMemory = memory;
    }

    /**
     * Check if browser is currently active and the page is still usable.
     */
    isActive(): boolean {
        if (!this.browser || !this.page) return false;
        try {
            // Playwright pages that have been closed throw on .url()
            this.page.url();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Start the browser session
     */
    async start(options?: BrowserSessionOptions): Promise<void> {
        if (this.isActive()) {
            console.log("🌐 Browser session already active");
            return;
        }

        const opts = { ...this.options, ...options };
        this.options = opts;
        console.log(`🌐 Starting browser session (headless: ${opts.headless})`);

        const { chromium } = await import("playwright");
        this.browser = await chromium.launch({ headless: opts.headless });

        const contextOptions: Parameters<Browser["newContext"]>[0] = {
            viewport: { width: opts.viewportWidth!, height: opts.viewportHeight! },
        };

        // Load auth state if provided
        if (opts.storageStatePath) {
            try {
                const fs = await import("node:fs");
                if (fs.existsSync(opts.storageStatePath)) {
                    contextOptions.storageState = opts.storageStatePath;
                    console.log(`🔐 Loaded auth state from ${opts.storageStatePath}`);
                }
            } catch (error) {
                console.warn("⚠️ Failed to load auth state:", error);
            }
        }

        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(opts.timeout!);

        console.log("✅ Browser session started");
    }

    /**
     * Close the browser session
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
            console.log("🔒 Browser session closed");
        }
    }

    /**
     * Reset the singleton (for testing)
     */
    static async reset(): Promise<void> {
        if (BrowserSession.instance) {
            try {
                await BrowserSession.instance.close();
            } catch (err) {
                console.warn("Browser close failed during reset:", err);
            }
            BrowserSession.instance = null;
        }
    }

    // =========================================================================
    // Navigation
    // =========================================================================

    /**
     * Navigate to a URL. If the browser/page was closed externally,
     * automatically restarts the session before navigating.
     */
    async navigate(url: string): Promise<DOMContext> {
        if (!this.isActive()) {
            console.log("🔄 Browser session lost, restarting...");
            await this.close();
            await this.start(this.options);
        }

        console.log(`🔗 Navigating to: ${url}`);

        try {
            await this.page!.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: this.options.timeout,
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("has been closed") || msg.includes("Target closed")) {
                console.log("🔄 Page closed during navigation, restarting session...");
                await this.close();
                await this.start(this.options);
                await this.page!.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: this.options.timeout,
                });
            } else {
                throw new BrowserActionError("navigate", url, error);
            }
        }

        await this.waitForIdle();

        return this.captureCurrentPage();
    }

    /**
     * Reload the current page
     */
    async reload(): Promise<DOMContext> {
        this.ensureActive();
        console.log("🔄 Reloading page");

        try {
            await this.page!.reload({ waitUntil: "domcontentloaded" });
        } catch (error) {
            throw new BrowserActionError("reload", this.page!.url(), error);
        }

        await this.waitForIdle();

        return this.captureCurrentPage();
    }

    /**
     * Go back in history
     */
    async goBack(): Promise<DOMContext | null> {
        this.ensureActive();
        console.log("⬅️ Going back");

        try {
            const response = await this.page!.goBack({ waitUntil: "domcontentloaded" });
            if (!response) {
                return null;
            }
        } catch (error) {
            throw new BrowserActionError("goBack", this.page!.url(), error);
        }

        await this.waitForIdle();
        return this.captureCurrentPage();
    }

    /**
     * Go forward in history
     */
    async goForward(): Promise<DOMContext | null> {
        this.ensureActive();
        console.log("➡️ Going forward");

        try {
            const response = await this.page!.goForward({ waitUntil: "domcontentloaded" });
            if (!response) {
                return null;
            }
        } catch (error) {
            throw new BrowserActionError("goForward", this.page!.url(), error);
        }

        await this.waitForIdle();
        return this.captureCurrentPage();
    }

    /**
     * Get current URL
     */
    getCurrentUrl(): string {
        this.ensureActive();
        return this.page!.url();
    }

    // =========================================================================
    // Interaction
    // =========================================================================

    /**
     * Click an element using DOM-derived selectors.
     * Each selector was built from a real attribute observed on the page.
     */
    async click(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("click", selectors, (loc) => loc.click({ timeout: 5000 }));
    }

    /**
     * Fill an input using DOM-derived selectors.
     * Each selector was built from a real attribute observed on the page.
     */
    async fill(selectors: string | string[], value: string): Promise<void> {
        await this.runWithSelectors("fill", selectors, (loc) => loc.fill(value, { timeout: 5000 }));
    }

    /**
     * Turn a selector string into a Playwright Locator.
     * Supports: role=button[name="X"], text=X, label=X, placeholder=X,
     * getByRole('...'), getByText('...'), and plain CSS.
     */
    private resolveLocator(selector: string): import("playwright").Locator {
        const page = this.page!;

        // Extract the inner string from patterns like getByX('...' ) or getByX("...")
        // Handles escaped quotes inside the string (e.g. O\'Brien)
        const extractArg = (s: string, prefix: string): string | null => {
            if (!s.startsWith(prefix)) return null;
            const rest = s.slice(prefix.length);
            const quote = rest[0];
            if (quote !== "'" && quote !== '"') return null;
            let i = 1;
            while (i < rest.length) {
                if (rest[i] === "\\" && i + 1 < rest.length) { i += 2; continue; }
                if (rest[i] === quote) return rest.slice(1, i).replace(/\\'/g, "'").replace(/\\"/g, '"');
                i++;
            }
            return null;
        };

        // getByRole('button', { name: 'Submit' })
        if (selector.startsWith("getByRole(")) {
            const roleEnd = selector.indexOf("'", 11);
            if (roleEnd === -1) return page.locator(selector);
            const role = selector.slice(11, roleEnd);
            const nameMatch = selector.match(/name:\s*['"](.+?)['"]\s*\}/);
            if (nameMatch) {
                return page.getByRole(role as any, { name: nameMatch[1].replace(/\\'/g, "'") });
            }
            return page.getByRole(role as any);
        }

        // getByTestId('...')
        const testIdArg = extractArg(selector, "getByTestId(");
        if (testIdArg !== null) return page.getByTestId(testIdArg);

        // getByLabel('...')
        const labelArg = extractArg(selector, "getByLabel(");
        if (labelArg !== null) return page.getByLabel(labelArg);

        // getByPlaceholder('...')
        const placeholderArg = extractArg(selector, "getByPlaceholder(");
        if (placeholderArg !== null) return page.getByPlaceholder(placeholderArg);

        // getByText('...')
        const textArg = extractArg(selector, "getByText(");
        if (textArg !== null) return page.getByText(textArg);

        // role=button[name="Submit"] (legacy format from earlier versions)
        const roleMatch = selector.match(/^role=(\w+)\[name="(.+?)"\]/);
        if (roleMatch) {
            return page.getByRole(roleMatch[1] as any, { name: roleMatch[2] });
        }

        // text=... / label=... / placeholder=... (legacy shorthand)
        if (selector.startsWith("text=")) return page.getByText(selector.slice(5));
        if (selector.startsWith("label=")) return page.getByLabel(selector.slice(6));
        if (selector.startsWith("placeholder=")) return page.getByPlaceholder(selector.slice(12));

        // CSS / attribute selectors (e.g. #id, input[name="x"], button[type="submit"])
        return page.locator(selector);
    }

    /**
     * Run an action against one or more selectors via resolveLocator,
     * returning on the first success.
     */
    private async runWithSelectors(
        action: string,
        selectors: string | string[],
        fn: (locator: import("playwright").Locator) => Promise<void>,
    ): Promise<void> {
        this.ensureActive();
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const element = list[0] || "unknown";
        console.log(`  ${action}: ${element}${list.length > 1 ? ` (+${list.length - 1} alternatives)` : ""}`);
        let lastError: unknown;
        const failed: string[] = [];
        for (const sel of list) {
            try {
                const locator = this.resolveLocator(sel);
                await fn(locator);
                for (const bad of failed) {
                    this.reportSelectorFailure(element, bad);
                }
                this.reportSelectorSuccess(element, sel);
                return;
            } catch (error) {
                lastError = error;
                failed.push(sel);
            }
        }
        for (const bad of failed) {
            this.reportSelectorFailure(element, bad);
        }
        throw new BrowserActionError(action, element, lastError);
    }

    /**
     * Type text (appends to existing value)
     */
    async type(selectors: string | string[], text: string): Promise<void> {
        await this.runWithSelectors("type", selectors, (loc) => loc.pressSequentially(text, { timeout: 5000 }));
    }

    /**
     * Press a key
     */
    async press(key: string): Promise<void> {
        this.ensureActive();
        console.log(`⌨️ Pressing key: ${key}`);
        try {
            await this.page!.keyboard.press(key);
        } catch (error) {
            throw new BrowserActionError("press", key, error);
        }
    }

    /**
     * Select option from dropdown
     */
    async selectOption(selectors: string | string[], value: string): Promise<void> {
        await this.runWithSelectors("selectOption", selectors, async (loc) => { await loc.selectOption(value, { timeout: 5000 }); });
    }

    /**
     * Check a checkbox
     */
    async check(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("check", selectors, (loc) => loc.check({ timeout: 5000 }));
    }

    /**
     * Uncheck a checkbox
     */
    async uncheck(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("uncheck", selectors, (loc) => loc.uncheck({ timeout: 5000 }));
    }

    /**
     * Hover over an element
     */
    async hover(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("hover", selectors, (loc) => loc.hover({ timeout: 5000 }));
    }

    /**
     * Focus an element
     */
    async focus(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("focus", selectors, (loc) => loc.focus({ timeout: 5000 }));
    }

    // =========================================================================
    // Waiting
    // =========================================================================

    /**
     * Wait for a selector to appear
     */
    async waitForSelector(selectors: string | string[], timeout?: number): Promise<void> {
        this.ensureActive();
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const element = list[0] || "unknown";
        console.log(`⏳ Waiting for: ${element}`);
        const effectiveTimeout = timeout || this.options.timeout;
        let lastError: unknown;
        const failed: string[] = [];
        for (const sel of list) {
            try {
                const locator = this.resolveLocator(sel);
                await locator.waitFor({ state: "visible", timeout: effectiveTimeout });
                for (const bad of failed) {
                    this.reportSelectorFailure(element, bad);
                }
                this.reportSelectorSuccess(element, sel);
                return;
            } catch (error) {
                lastError = error;
                failed.push(sel);
            }
        }
        for (const bad of failed) {
            this.reportSelectorFailure(element, bad);
        }
        throw new BrowserActionError("waitForSelector", element, lastError);
    }

    /**
     * Wait for navigation to complete
     */
    async waitForNavigation(timeout?: number): Promise<void> {
        this.ensureActive();
        console.log("⏳ Waiting for navigation");
        try {
            await this.page!.waitForNavigation({ timeout: timeout || this.options.timeout });
        } catch (error) {
            throw new BrowserActionError("waitForNavigation", this.page!.url(), error);
        }
    }

    /**
     * Wait for network to be idle
     */
    async waitForNetworkIdle(timeout?: number): Promise<void> {
        this.ensureActive();
        console.log("⏳ Waiting for network idle");
        await this.page!.waitForLoadState("networkidle", { timeout: timeout || 5000 });
    }

    /**
     * Wait for a fixed amount of time
     */
    async wait(ms: number): Promise<void> {
        console.log(`⏳ Waiting ${ms}ms`);
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    // =========================================================================
    // State Capture
    // =========================================================================

    /**
     * Capture the current page state.
     * Handles the case where the page was navigated away or closed by
     * retrying once after detecting a stale page reference.
     */
    async captureCurrentPage(): Promise<DOMContext> {
        this.ensureActive();

        try {
            return await this.capturePageInternal();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("has been closed") || msg.includes("Target closed")) {
                // Page died, try to recover by grabbing a new page from the context
                if (this.context) {
                    const pages = this.context.pages();
                    if (pages.length > 0) {
                        this.page = pages[pages.length - 1];
                        console.log("🔄 Recovered page reference from context");
                        return await this.capturePageInternal();
                    }
                }
            }
            throw new BrowserActionError("captureCurrentPage", this.page?.url() || "unknown", error);
        }
    }

    private async capturePageInternal(): Promise<DOMContext> {
        const url = this.page!.url();
        const title = await this.page!.title();

        console.log(`📸 Capturing page: ${title}`);

        const interactiveElements = await this.collectInteractiveElements();
        const formFields = await this.collectFormFields();

        const accessibilityTree = this.buildSimpleTree(title, interactiveElements, formFields);

        return {
            url,
            title,
            accessibilityTree,
            interactiveElements,
            formFields,
            timestamp: Date.now(),
        };
    }

    /**
     * Take a screenshot
     */
    async screenshot(): Promise<Buffer> {
        this.ensureActive();
        console.log("📷 Taking screenshot");
        return this.page!.screenshot();
    }

    /**
     * Discover all links on the current page (lightweight, no full DOM capture).
     *
     * Each link carries DOM-derived `suggestedSelectors` built from the same
     * observed-attribute logic as the rest of the browser layer, so downstream
     * persistence and test generation never need to fabricate selectors.
     */
    async discoverLinks(): Promise<
        Array<{
            text: string;
            href: string;
            isExternal: boolean;
            suggestedSelectors: string[];
        }>
    > {
        this.ensureActive();
        console.log("🔍 Discovering links on page");

        const currentUrl = new URL(this.page!.url());
        const currentOrigin = currentUrl.origin;
        const discovered: Array<{
            text: string;
            href: string;
            isExternal: boolean;
            suggestedSelectors: string[];
        }> = [];
        const seenHrefs = new Set<string>();

        const addLink = (
            text: string,
            href: string,
            suggestedSelectors: string[],
        ) => {
            if (!href || href.startsWith("#") || href.startsWith("javascript:") || href === "about:blank") return;
            let fullUrl: string;
            try {
                fullUrl = new URL(href, currentUrl).href;
            } catch {
                return;
            }
            const normalized = fullUrl.replace(/\/$/, "");
            if (seenHrefs.has(normalized)) return;
            seenHrefs.add(normalized);
            discovered.push({
                text: text.trim().slice(0, 100),
                href: fullUrl,
                isExternal: !fullUrl.startsWith(currentOrigin),
                suggestedSelectors,
            });
        };

        // 1. Standard <a href> links
        const anchorLinks = await this.page!.locator("a[href]").all();
        for (const link of anchorLinks.slice(0, 100)) {
            try {
                const href = await link.getAttribute("href");
                const text = ((await link.textContent()) || "").trim();
                const testId = await link.getAttribute("data-testid");
                const ariaLabel = await link.getAttribute("aria-label");
                const htmlId = await link.getAttribute("id");
                const selectors = this.buildSelectors(
                    "link",
                    ariaLabel || text,
                    testId,
                    {
                        htmlId: htmlId || undefined,
                        ariaLabel: ariaLabel || undefined,
                    },
                );
                addLink(text, href || "", selectors);
            } catch { /* inaccessible */ }
        }

        // 2. SPA-aware: elements with role="link" that aren't <a> tags
        //    (custom components rendered as divs/spans with link semantics)
        const roleLinks = await this.page!.locator('[role="link"]:not(a)').all();
        for (const el of roleLinks.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(el))) continue;
                const href =
                    (await el.getAttribute("data-href")) ||
                    (await el.getAttribute("data-url")) ||
                    (await el.getAttribute("data-to"));
                if (!href) continue;
                const text = ((await el.textContent()) || "").trim();
                const testId = await el.getAttribute("data-testid");
                const ariaLabel = await el.getAttribute("aria-label");
                const htmlId = await el.getAttribute("id");
                const selectors = this.buildSelectors("link", ariaLabel || text, testId, {
                    htmlId: htmlId || undefined,
                    ariaLabel: ariaLabel || undefined,
                });
                addLink(text, href, selectors);
            } catch { /* inaccessible */ }
        }

        // 3. SPA-aware: clickable navigation elements inside <nav>
        //    Many SPAs use <button> or <div> inside <nav> for client-side routing
        const navClickables = await this.page!.locator('nav button, nav [role="button"], nav [role="tab"], nav [role="menuitem"]').all();
        for (const el of navClickables.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(el))) continue;
                const href =
                    (await el.getAttribute("data-href")) ||
                    (await el.getAttribute("data-url")) ||
                    (await el.getAttribute("data-to")) ||
                    (await el.getAttribute("data-path"));
                if (!href) continue;
                const text = ((await el.textContent()) || "").trim();
                const testId = await el.getAttribute("data-testid");
                const ariaLabel = await el.getAttribute("aria-label");
                const htmlId = await el.getAttribute("id");
                const role = (await el.getAttribute("role")) || "button";
                const selectors = this.buildSelectors(role, ariaLabel || text, testId, {
                    htmlId: htmlId || undefined,
                    ariaLabel: ariaLabel || undefined,
                });
                addLink(text, href, selectors);
            } catch { /* inaccessible */ }
        }

        console.log(`✓ Found ${discovered.length} unique links`);
        return discovered;
    }

    // =========================================================================
    // Auth State
    // =========================================================================

    /**
     * Save current auth state to file
     */
    async saveAuthState(path: string): Promise<void> {
        this.ensureActive();
        console.log(`💾 Saving auth state to: ${path}`);
        await this.context!.storageState({ path });
    }

    /**
     * Load auth state from file
     */
    async loadAuthState(path: string): Promise<void> {
        if (!this.browser) {
            throw new Error("Browser not started. Call start() first.");
        }

        console.log(`📂 Loading auth state from: ${path}`);

        // Close existing context and create new one with auth state
        if (this.context) {
            await this.context.close();
        }

        this.context = await this.browser.newContext({
            viewport: { width: this.options.viewportWidth!, height: this.options.viewportHeight! },
            storageState: path,
        });

        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.options.timeout!);
    }

    /**
     * Lightweight structural check for blocking overlays (modals, dialogs,
     * consent banners). Returns true if an aria-modal, open dialog, or
     * viewport-covering fixed element is detected.
     */
    async hasBlockingOverlay(): Promise<boolean> {
        if (!this.isActive()) return false;
        try {
            const count = await this.page!.locator(
                '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]'
            ).count();
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

    private reportSelectorSuccess(element: string, selector: string): void {
        if (!this.selectorMemory) return;
        try {
            this.selectorMemory.recordSuccess(
                element,
                selector,
                classifySelector(selector),
            );
        } catch {
            // Memory must never break a browser action.
        }
    }

    private reportSelectorFailure(element: string, selector: string): void {
        if (!this.selectorMemory) return;
        try {
            this.selectorMemory.recordFailure(
                element,
                selector,
                classifySelector(selector),
            );
        } catch {
            // Memory must never break a browser action.
        }
    }

    private getAllFrames(): import("playwright").Frame[] {
        const frames = this.page!.frames();
        const main = this.page!.mainFrame();
        const ordered = [main, ...frames.filter((f) => f !== main)];
        const unique = new Set<import("playwright").Frame>();
        const deduped: import("playwright").Frame[] = [];
        for (const frame of ordered) {
            if (!unique.has(frame)) {
                unique.add(frame);
                deduped.push(frame);
            }
        }
        return deduped;
    }

    private dedupeElements(elements: InteractiveElement[]): InteractiveElement[] {
        const seen = new Set<string>();
        const result: InteractiveElement[] = [];
        for (const el of elements) {
            const key = `${el.role || ""}|${el.name || ""}|${el.testId || ""}|${el.tagName}|${el.type || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(el);
        }
        return result;
    }

    private dedupeFields(fields: FormField[]): FormField[] {
        const seen = new Set<string>();
        const result: FormField[] = [];
        for (const field of fields) {
            const key = `${field.name}|${field.type}|${field.id || ""}|${field.suggestedSelector}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(field);
        }
        return result;
    }

    private async collectInteractiveElements(): Promise<InteractiveElement[]> {
        const collected: InteractiveElement[] = [];

        for (const frame of this.getAllFrames()) {
            try {
                const elements = await this.extractElementsFromScope(frame);
                collected.push(...elements);
            } catch {
                continue;
            }
            if (collected.length >= 60) break;
        }

        return this.dedupeElements(collected).slice(0, 60);
    }

    private async extractElementsFromScope(scope: import("playwright").Frame): Promise<InteractiveElement[]> {
        const elements: InteractiveElement[] = [];

        const buttons = await scope.locator('button, [role="button"], input[type="submit"], input[type="button"]').all();
        for (const btn of buttons.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(btn))) continue;
                const ariaLabel = (await btn.getAttribute("aria-label")) || "";
                const text = (await btn.textContent()) || ariaLabel || "";
                const testId = await btn.getAttribute("data-testid");
                const btnType = await btn.getAttribute("type");
                const btnId = await btn.getAttribute("id");
                const displayName = text.trim();
                elements.push({
                    tagName: "button",
                    role: "button",
                    text: displayName,
                    name: displayName,
                    testId: testId || undefined,
                    htmlId: btnId || undefined,
                    ariaLabel: ariaLabel || undefined,
                    suggestedSelectors: this.buildSelectors("button", displayName, testId, {
                        htmlId: btnId || undefined,
                        ariaLabel: ariaLabel || undefined,
                        type: btnType || undefined,
                    }),
                });
            } catch { /* inaccessible */ }
        }

        const links = await scope.locator("a[href]").all();
        for (const link of links.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(link))) continue;
                const text = (await link.textContent()) || "";
                const href = (await link.getAttribute("href")) || "";
                elements.push({
                    tagName: "a",
                    role: "link",
                    text: text.trim(),
                    name: text.trim() || href,
                    suggestedSelectors: this.buildSelectors("link", text.trim()),
                });
            } catch { /* inaccessible */ }
        }

        const inputs = await scope.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select').all();
        for (const input of inputs.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(input))) continue;
                const type = (await input.getAttribute("type")) || "text";
                const htmlName = (await input.getAttribute("name")) || "";
                const placeholder = (await input.getAttribute("placeholder")) || "";
                const label = (await input.getAttribute("aria-label")) || "";
                const testId = await input.getAttribute("data-testid");
                const htmlId = (await input.getAttribute("id")) || "";
                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
                const role =
                    type === "checkbox"
                        ? "checkbox"
                        : type === "radio"
                          ? "radio"
                          : type === "range"
                            ? "slider"
                            : tagName === "select"
                              ? "combobox"
                              : "textbox";
                const displayName = label || placeholder || htmlName;
                elements.push({
                    tagName,
                    role,
                    type,
                    name: displayName,
                    text: placeholder,
                    testId: testId || undefined,
                    htmlName: htmlName || undefined,
                    htmlId: htmlId || undefined,
                    placeholder: placeholder || undefined,
                    ariaLabel: label || undefined,
                    suggestedSelectors: this.buildSelectors(role, displayName, testId, {
                        htmlName: htmlName || undefined,
                        htmlId: htmlId || undefined,
                        placeholder: placeholder || undefined,
                        ariaLabel: label || undefined,
                        type,
                    }),
                });
            } catch { /* inaccessible */ }
        }

        // Contenteditable elements
        const contentEditables = await scope.locator('[contenteditable="true"]').all();
        for (const editable of contentEditables.slice(0, 10)) {
            try {
                if (!(await this.isUsableElement(editable))) continue;
                const text = (await editable.textContent()) || "";
                const label = (await editable.getAttribute("aria-label")) || "";
                const testId = await editable.getAttribute("data-testid");
                elements.push({
                    tagName: "div",
                    role: "textbox",
                    text: text.trim(),
                    name: label || text.trim(),
                    testId: testId || undefined,
                    suggestedSelectors: this.buildSelectors("textbox", label || text.trim(), testId),
                });
            } catch { /* inaccessible */ }
        }

        // ARIA role elements
        const roleElements = await scope
            .locator('[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"]')
            .all();
        for (const el of roleElements.slice(0, 20)) {
            try {
                if (!(await this.isUsableElement(el))) continue;
                const role = (await el.getAttribute("role")) || "";
                const text = (await el.textContent()) || (await el.getAttribute("aria-label")) || "";
                const testId = await el.getAttribute("data-testid");
                elements.push({
                    tagName: "div",
                    role: role || undefined,
                    text: text.trim(),
                    name: text.trim(),
                    testId: testId || undefined,
                    suggestedSelectors: this.buildSelectors(role || "button", text.trim(), testId),
                });
            } catch { /* inaccessible */ }
        }

        return elements;
    }

    private async collectFormFields(): Promise<FormField[]> {
        const collected: FormField[] = [];

        for (const frame of this.getAllFrames()) {
            try {
                const fields = await this.extractFieldsFromScope(frame);
                collected.push(...fields);
            } catch {
                continue;
            }
            if (collected.length >= 60) break;
        }

        return this.dedupeFields(collected).slice(0, 60);
    }

    private async extractFieldsFromScope(scope: import("playwright").Frame): Promise<FormField[]> {
        const fields: FormField[] = [];

        const inputs = await scope.locator('input:not([type="hidden"]), textarea, select').all();
        for (const input of inputs.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(input))) continue;
                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
                const type = (await input.getAttribute("type")) || (tagName === "textarea" ? "textarea" : "text");
                const name = (await input.getAttribute("name")) || "";
                const id = (await input.getAttribute("id")) || "";
                const placeholder = (await input.getAttribute("placeholder")) || "";
                const label = (await input.getAttribute("aria-label")) || "";
                const required = (await input.getAttribute("required")) !== null;

                fields.push({
                    name: label || placeholder || name || id,
                    type,
                    label: label || undefined,
                    placeholder: placeholder || undefined,
                    required,
                    id: id || undefined,
                    suggestedSelector: id ? `#${id}` : name ? `[name="${name}"]` : `[placeholder="${placeholder}"]`,
                });
            } catch { /* inaccessible */ }
        }

        return fields;
    }

    private async isUsableElement(locator: import("playwright").Locator): Promise<boolean> {
        try {
            if (!(await locator.isVisible())) return false;
            const box = await locator.boundingBox();
            if (!box || box.width === 0 || box.height === 0) return false;
            return true;
        } catch {
            return false;
        }
    }

    private async waitForIdle(): Promise<void> {
        await this.page!.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }

    /**
     * Build selectors from the actual DOM attributes of an element.
     * This is the single source of truth for all selectors in the system.
     * Every selector produced here was derived from a real attribute that
     * was observed on the element during page capture.
     */
    private buildSelectors(
        role: string,
        name: string,
        testId?: string | null,
        htmlAttrs?: { htmlName?: string; htmlId?: string; placeholder?: string; ariaLabel?: string; type?: string }
    ): string[] {
        const selectors: string[] = [];
        const esc = (s: string) => s.replace(/'/g, "\\'");
        const isInput = role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio" || role === "slider";
        const isButton = role === "button";

        // data-testid: most stable, framework-provided
        if (testId) selectors.push(`getByTestId('${esc(testId)}')`);

        // CSS from HTML attributes: direct, unambiguous
        if (htmlAttrs) {
            if (isInput && htmlAttrs.htmlName) {
                selectors.push(`input[name="${htmlAttrs.htmlName}"]`);
            }
            if (isInput && htmlAttrs.htmlId) {
                selectors.push(`#${htmlAttrs.htmlId}`);
            }
            if (isButton && htmlAttrs.htmlId) {
                selectors.push(`#${htmlAttrs.htmlId}`);
            }
            if (isButton && htmlAttrs.type === "submit") {
                selectors.push(`button[type="submit"]`);
            }
            if (isInput && htmlAttrs.type === "submit") {
                selectors.push(`input[type="submit"]`);
            }
            if (isInput && htmlAttrs.type === "password") {
                selectors.push(`input[type="password"]`);
            }
        }

        // Playwright semantic locators: accessible, resilient
        if (name) selectors.push(`getByRole('${esc(role)}', { name: '${esc(name)}' })`);
        if (htmlAttrs?.ariaLabel) {
            selectors.push(`getByLabel('${esc(htmlAttrs.ariaLabel)}')`);
        }
        if (htmlAttrs?.placeholder) {
            selectors.push(`getByPlaceholder('${esc(htmlAttrs.placeholder)}')`);
        }

        // Text content: last resort, least specific
        if (name) selectors.push(`getByText('${esc(name)}')`);

        return selectors;
    }

    private buildSimpleTree(
        title: string,
        elements: InteractiveElement[],
        fields: FormField[]
    ): AccessibilityNode {
        const children: AccessibilityNode[] = [];

        for (const el of elements) {
            children.push({
                role: el.role || el.tagName,
                name: el.name || el.text,
            });
        }

        const elementNames = new Set(elements.map((e) => e.name));
        for (const field of fields) {
            if (!elementNames.has(field.name)) {
                children.push({
                    role: field.type || "textbox",
                    name: field.name,
                    value: field.placeholder,
                });
            }
        }

        return {
            role: "WebArea",
            name: title,
            children,
        };
    }
}
