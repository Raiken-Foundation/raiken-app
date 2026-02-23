/**
 * BrowserSession - Persistent Playwright Browser Session
 *
 * Manages a single browser instance that stays open across tool calls.
 * Enables navigation, interaction, and page capture without browser restarts.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import type { DOMContext, InteractiveElement, FormField, AccessibilityNode } from "./dom-capture";

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
     * Get or create the browser session instance
     */
    static getInstance(projectPath: string): BrowserSession {
        if (!BrowserSession.instance) {
            BrowserSession.instance = new BrowserSession(projectPath);
        }
        return BrowserSession.instance;
    }

    /**
     * Check if browser is currently active
     */
    isActive(): boolean {
        return this.browser !== null && this.page !== null;
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
    static reset(): void {
        if (BrowserSession.instance) {
            BrowserSession.instance.close().catch((err) => {
                console.warn("Browser close failed during reset:", err);
            });
            BrowserSession.instance = null;
        }
    }

    // =========================================================================
    // Navigation
    // =========================================================================

    /**
     * Navigate to a URL
     */
    async navigate(url: string): Promise<DOMContext> {
        this.ensureActive();
        console.log(`🔗 Navigating to: ${url}`);

        await this.page!.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: this.options.timeout,
        });

        await this.waitForIdle();

        return this.captureCurrentPage();
    }

    /**
     * Reload the current page
     */
    async reload(): Promise<DOMContext> {
        this.ensureActive();
        console.log("🔄 Reloading page");

        await this.page!.reload({ waitUntil: "domcontentloaded" });
        await this.waitForIdle();

        return this.captureCurrentPage();
    }

    /**
     * Go back in history
     */
    async goBack(): Promise<DOMContext | null> {
        this.ensureActive();
        console.log("⬅️ Going back");

        const response = await this.page!.goBack({ waitUntil: "domcontentloaded" });
        if (!response) {
            return null;
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

        const response = await this.page!.goForward({ waitUntil: "domcontentloaded" });
        if (!response) {
            return null;
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
     * Click an element
     */
    async click(selector: string): Promise<void> {
        this.ensureActive();
        console.log(`🖱️ Clicking: ${selector}`);
        await this.page!.click(selector);
    }

    /**
     * Fill an input (clears existing value first)
     */
    async fill(selector: string, value: string): Promise<void> {
        this.ensureActive();
        console.log(`✏️ Filling: ${selector}`);
        await this.page!.fill(selector, value);
    }

    /**
     * Type text (appends to existing value)
     */
    async type(selector: string, text: string): Promise<void> {
        this.ensureActive();
        console.log(`⌨️ Typing into: ${selector}`);
        await this.page!.type(selector, text);
    }

    /**
     * Press a key
     */
    async press(key: string): Promise<void> {
        this.ensureActive();
        console.log(`⌨️ Pressing key: ${key}`);
        await this.page!.keyboard.press(key);
    }

    /**
     * Select option from dropdown
     */
    async selectOption(selector: string, value: string): Promise<void> {
        this.ensureActive();
        console.log(`📋 Selecting: ${value} from ${selector}`);
        await this.page!.selectOption(selector, value);
    }

    /**
     * Check a checkbox
     */
    async check(selector: string): Promise<void> {
        this.ensureActive();
        console.log(`☑️ Checking: ${selector}`);
        await this.page!.check(selector);
    }

    /**
     * Uncheck a checkbox
     */
    async uncheck(selector: string): Promise<void> {
        this.ensureActive();
        console.log(`⬜ Unchecking: ${selector}`);
        await this.page!.uncheck(selector);
    }

    /**
     * Hover over an element
     */
    async hover(selector: string): Promise<void> {
        this.ensureActive();
        console.log(`👆 Hovering: ${selector}`);
        await this.page!.hover(selector);
    }

    /**
     * Focus an element
     */
    async focus(selector: string): Promise<void> {
        this.ensureActive();
        console.log(`🎯 Focusing: ${selector}`);
        await this.page!.focus(selector);
    }

    // =========================================================================
    // Waiting
    // =========================================================================

    /**
     * Wait for a selector to appear
     */
    async waitForSelector(selector: string, timeout?: number): Promise<void> {
        this.ensureActive();
        console.log(`⏳ Waiting for: ${selector}`);
        await this.page!.waitForSelector(selector, { timeout: timeout || this.options.timeout });
    }

    /**
     * Wait for navigation to complete
     */
    async waitForNavigation(timeout?: number): Promise<void> {
        this.ensureActive();
        console.log("⏳ Waiting for navigation");
        await this.page!.waitForNavigation({ timeout: timeout || this.options.timeout });
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
     * Capture the current page state
     */
    async captureCurrentPage(): Promise<DOMContext> {
        this.ensureActive();

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
     * Discover all links on the current page (lightweight, no full DOM capture)
     */
    async discoverLinks(): Promise<Array<{ text: string; href: string; isExternal: boolean }>> {
        this.ensureActive();
        console.log("🔍 Discovering links on page");

        const currentUrl = new URL(this.page!.url());
        const currentOrigin = currentUrl.origin;

        const links = await this.page!.locator("a[href]").all();
        const discovered: Array<{ text: string; href: string; isExternal: boolean }> = [];
        const seenHrefs = new Set<string>();

        for (const link of links.slice(0, 100)) {
            try {
                const href = await link.getAttribute("href");
                if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

                // Normalize the href
                let fullUrl: string;
                try {
                    fullUrl = new URL(href, currentUrl).href;
                } catch {
                    continue;
                }

                // Skip duplicates
                if (seenHrefs.has(fullUrl)) continue;
                seenHrefs.add(fullUrl);

                const text = ((await link.textContent()) || "").trim().slice(0, 100);
                const isExternal = !fullUrl.startsWith(currentOrigin);

                discovered.push({ text, href: fullUrl, isExternal });
            } catch {
                // Link inaccessible
            }
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

    // =========================================================================
    // Private Helpers
    // =========================================================================

    private ensureActive(): void {
        if (!this.isActive()) {
            throw new Error("Browser session not active. Call start() first.");
        }
    }

    private async collectInteractiveElements(): Promise<InteractiveElement[]> {
        const elements: InteractiveElement[] = [];
        const page = this.page!;

        // Buttons
        const buttons = await page.locator('button, [role="button"], input[type="submit"], input[type="button"]').all();
        for (const btn of buttons.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(btn))) continue;
                const text = (await btn.textContent()) || (await btn.getAttribute("aria-label")) || "";
                const testId = await btn.getAttribute("data-testid");
                elements.push({
                    tagName: "button",
                    role: "button",
                    text: text.trim(),
                    name: text.trim(),
                    testId: testId || undefined,
                    suggestedSelectors: this.buildSelectors("button", text.trim(), testId),
                });
            } catch {
                // Element inaccessible
            }
        }

        // Links
        const links = await page.locator("a[href]").all();
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
            } catch {
                // Element inaccessible
            }
        }

        // Inputs
        const inputs = await page.locator('input:not([type="hidden"]), textarea, select').all();
        for (const input of inputs.slice(0, 30)) {
            try {
                if (!(await this.isUsableElement(input))) continue;
                const type = (await input.getAttribute("type")) || "text";
                const name = (await input.getAttribute("name")) || "";
                const placeholder = (await input.getAttribute("placeholder")) || "";
                const label = (await input.getAttribute("aria-label")) || "";
                const testId = await input.getAttribute("data-testid");
                const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
                const role =
                    type === "checkbox"
                        ? "checkbox"
                        : type === "radio"
                          ? "radio"
                          : tagName === "select"
                            ? "combobox"
                            : "textbox";
                elements.push({
                    tagName,
                    role,
                    type,
                    name: label || placeholder || name,
                    text: placeholder,
                    testId: testId || undefined,
                    suggestedSelectors: this.buildSelectors(role, label || placeholder || name, testId),
                });
            } catch {
                // Element inaccessible
            }
        }

        return elements;
    }

    private async collectFormFields(): Promise<FormField[]> {
        const fields: FormField[] = [];
        const page = this.page!;

        const inputs = await page.locator('input:not([type="hidden"]), textarea, select').all();
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
            } catch {
                // Field inaccessible
            }
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

    private buildSelectors(role: string, name: string, testId?: string | null): string[] {
        const selectors: string[] = [];
        if (testId) selectors.push(`getByTestId('${testId}')`);
        if (name) selectors.push(`getByRole('${role}', { name: '${name}' })`);
        if (name) selectors.push(`getByText('${name}')`);
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
