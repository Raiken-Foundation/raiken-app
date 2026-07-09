/**
 * BrowserSession - Persistent Playwright Browser Session
 *
 * Manages a single browser instance that stays open across tool calls.
 * Enables navigation, interaction, and page capture without browser restarts.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import type {
    AccessibilityNode,
    DOMContext,
    FormField,
    InteractiveElement,
    PagePerformance,
} from "./dom-capture";

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
export type SelectorKind = "data-testid" | "role" | "text" | "css" | "xpath" | "other";

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
    if (/^[#.[]/.test(s) || /^[a-zA-Z]+(\[|\.|\s|$)/.test(s)) return "css";
    return "other";
}

/**
 * Produce a single stable selector for a form field from its observed
 * attributes, in decreasing order of robustness. Every branch is grounded in
 * an attribute that was actually read off the element — nothing is fabricated.
 * Values are escaped so quotes/backslashes in attributes don't break the CSS.
 */
export function buildFieldSelector(attrs: {
    testId?: string;
    id?: string;
    name?: string;
    label?: string;
    placeholder?: string;
}): string {
    const esc = (s: string) => s.replace(/(["\\])/g, "\\$1");
    if (attrs.testId) return `getByTestId('${attrs.testId.replace(/'/g, "\\'")}')`;
    if (attrs.id) return `#${attrs.id.replace(/(["\\#.:[\]])/g, "\\$1")}`;
    if (attrs.name) return `[name="${esc(attrs.name)}"]`;
    if (attrs.label) return `getByLabel('${attrs.label.replace(/'/g, "\\'")}')`;
    if (attrs.placeholder) return `[placeholder="${esc(attrs.placeholder)}"]`;
    return "input";
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
 * Raw element descriptor returned by the single in-page extraction pass.
 * All attribute reads and the visibility/accessible-name computation happen
 * inside one `frame.evaluate()` call (one round-trip per frame) instead of
 * dozens of sequential Playwright calls per element. Selectors are built in
 * Node from these fields by {@link BrowserSession.buildSelectors}.
 */
interface RawElement {
    tag: string;
    role: string;
    name: string;
    text: string;
    type: string | null;
    testId: string | null;
    htmlId: string | null;
    htmlName: string | null;
    href: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    required: boolean;
    /** True for text-entry controls (input/textarea/select/contenteditable). */
    isFormField: boolean;
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
    // In-flight launch guard: two concurrent tool calls (e.g. capture + navigate)
    // must not both call chromium.launch() and orphan a Chromium process.
    private startPromise: Promise<void> | null = null;

    // Behavior signals from the most recent navigation, folded into the next
    // page capture so the test generator can calibrate waits to reality.
    private lastNavigationMs?: number;
    private lastNetworkIdle?: boolean;
    private lastSlowResponses?: PagePerformance["slowResponses"];

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
            const prev = BrowserSession.instance;
            prev.projectPath = projectPath;
            prev.selectorMemory = null;
            // A different project must not reuse the previous project's browser
            // context (cookies, auth storage state, open tabs). Detach the old
            // browser immediately so isActive() reports false right away, and
            // close it in the background. The next start() launches fresh with
            // the new project's auth-state path.
            if (prev.browser) {
                const toClose = prev.browser;
                prev.browser = null;
                prev.context = null;
                prev.page = null;
                void toClose.close().catch(() => {
                    /* already gone */
                });
            }
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
            return;
        }

        // Serialize concurrent starts: if a launch is already underway, await it
        // instead of launching a second browser.
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

    private async doStart(options?: BrowserSessionOptions): Promise<void> {
        // We're not active but a browser handle may still be around (e.g. the
        // page crashed or was closed out from under us). Tear it down first so
        // we don't leak an orphaned Chromium process on relaunch.
        if (this.browser) {
            await this.close();
        }

        const opts = { ...this.options, ...options };

        // Global override: the interactive CLI (`raiken chat`) sets
        // RAIKEN_HEADLESS=0 so the tester can watch the agent drive the page,
        // regardless of what individual tool calls request. "1"/"true" forces
        // headless (e.g. CI). Unset → honor the per-call option.
        const envHeadless = process.env["RAIKEN_HEADLESS"]?.trim().toLowerCase();
        if (envHeadless === "0" || envHeadless === "false") {
            opts.headless = false;
        } else if (envHeadless === "1" || envHeadless === "true") {
            opts.headless = true;
        }

        this.options = opts;

        const { chromium } = await import("playwright");
        this.browser = await chromium.launch({ headless: opts.headless });

        try {
            const contextOptions: Parameters<Browser["newContext"]>[0] = {
                viewport: { width: opts.viewportWidth!, height: opts.viewportHeight! },
            };

            // Load auth state if provided
            if (opts.storageStatePath) {
                try {
                    const fs = await import("node:fs");
                    if (fs.existsSync(opts.storageStatePath)) {
                        contextOptions.storageState = opts.storageStatePath;
                    }
                } catch (error) {
                    console.warn("Failed to load auth state:", error);
                }
            }

            this.context = await this.browser.newContext(contextOptions);
            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(opts.timeout!);
        } catch (error) {
            // Context/page creation failed — don't leave a launched-but-unusable
            // Chromium process (and inconsistent handles) behind.
            await this.close();
            throw error;
        }
    }

    /**
     * Close the browser session
     */
    async close(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (error) {
                // Browser may already be gone; still clear our handles so the
                // session can be cleanly restarted.
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

    /**
     * Close the active singleton browser (if any) without discarding the
     * instance. Intended for process shutdown so Chromium doesn't linger.
     */
    static async closeInstance(): Promise<void> {
        if (BrowserSession.instance) {
            await BrowserSession.instance.close();
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
            await this.close();
            await this.start(this.options);
        }

        const navStart = Date.now();
        let stopCollecting = this.collectResponseTimings();

        try {
            try {
                await this.page!.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: this.options.timeout,
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (msg.includes("has been closed") || msg.includes("Target closed")) {
                    stopCollecting();
                    await this.close();
                    await this.start(this.options);
                    stopCollecting = this.collectResponseTimings();
                    await this.page!.goto(url, {
                        waitUntil: "domcontentloaded",
                        timeout: this.options.timeout,
                    });
                } else {
                    throw new BrowserActionError("navigate", url, error);
                }
            }

            this.lastNetworkIdle = await this.waitForIdle();
            // SPAs mount after domcontentloaded/networkidle; wait for real
            // interactive content to exist so we don't capture a blank shell.
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } finally {
            // Always detach the response listener, even if waitForIdle/goto throws,
            // otherwise every failed navigation leaks a "response" handler.
            this.lastSlowResponses = stopCollecting();
        }

        return this.captureCurrentPage();
    }

    /**
     * Reload the current page
     */
    async reload(): Promise<DOMContext> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = this.collectResponseTimings();
        try {
            await this.page!.reload({ waitUntil: "domcontentloaded" });
            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("reload", this.page!.url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }

        return this.captureCurrentPage();
    }

    /**
     * Go back in history
     */
    async goBack(): Promise<DOMContext | null> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = this.collectResponseTimings();
        try {
            const response = await this.page!.goBack({ waitUntil: "domcontentloaded" });
            if (!response) {
                return null;
            }
            this.lastNetworkIdle = await this.waitForIdle();
            // SPAs re-render client-side after a history nav — wait for real
            // content so the capture isn't of a transient/empty frame.
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("goBack", this.page!.url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }
        return this.captureCurrentPage();
    }

    /**
     * Go forward in history
     */
    async goForward(): Promise<DOMContext | null> {
        this.ensureActive();

        const navStart = Date.now();
        const stopCollecting = this.collectResponseTimings();
        try {
            const response = await this.page!.goForward({ waitUntil: "domcontentloaded" });
            if (!response) {
                return null;
            }
            this.lastNetworkIdle = await this.waitForIdle();
            await this.waitForContent();
            this.lastNavigationMs = Date.now() - navStart;
        } catch (error) {
            throw new BrowserActionError("goForward", this.page!.url(), error);
        } finally {
            this.lastSlowResponses = stopCollecting();
        }
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
     * Timeout for a single interaction. Derived from the session timeout but
     * capped so a slow SPA doesn't make every click/fill wait the full page
     * timeout, while still being generous enough that actions don't fail on
     * apps that legitimately take a few seconds to become interactive. (The old
     * hardcoded 5s failed too eagerly on slower apps.)
     */
    private actionTimeoutMs(): number {
        const base = this.options.timeout ?? 30000;
        return Math.min(Math.max(base, 5000), 15000);
    }

    /**
     * Click an element using DOM-derived selectors.
     * Each selector was built from a real attribute observed on the page.
     */
    async click(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("click", selectors, (loc) =>
            loc.click({ timeout: this.actionTimeoutMs() }),
        );
    }

    /**
     * Fill an input using DOM-derived selectors.
     * Each selector was built from a real attribute observed on the page.
     * Falls back to `selectOption` when the target is a native <select> (which
     * cannot be `fill()`-ed) so combobox/dropdown auth fields don't silently
     * fail.
     */
    async fill(selectors: string | string[], value: string): Promise<void> {
        await this.runWithSelectors("fill", selectors, async (loc) => {
            try {
                await loc.fill(value, { timeout: this.actionTimeoutMs() });
            } catch (error) {
                const tag = await loc
                    .evaluate((el) => (el as HTMLElement).tagName?.toLowerCase())
                    .catch(() => "");
                if (tag === "select") {
                    await loc
                        .selectOption({ label: value })
                        .catch(async () => await loc.selectOption(value));
                    return;
                }
                throw error;
            }
        });
    }

    /**
     * Turn a selector string into a Playwright Locator.
     * Supports: role=button[name="X"], text=X, label=X, placeholder=X,
     * getByRole('...'), getByText('...'), and plain CSS.
     */
    private resolveLocator(
        selector: string,
        scope: import("playwright").Page | import("playwright").Frame = this.page!,
    ): import("playwright").Locator {
        const page = scope;

        // Extract the inner string from patterns like getByX('...' ) or getByX("...")
        // Handles escaped quotes inside the string (e.g. O\'Brien)
        const extractArg = (s: string, prefix: string): string | null => {
            if (!s.startsWith(prefix)) return null;
            const rest = s.slice(prefix.length);
            const quote = rest[0];
            if (quote !== "'" && quote !== '"') return null;
            let i = 1;
            while (i < rest.length) {
                if (rest[i] === "\\" && i + 1 < rest.length) {
                    i += 2;
                    continue;
                }
                if (rest[i] === quote)
                    return rest.slice(1, i).replace(/\\'/g, "'").replace(/\\"/g, '"');
                i++;
            }
            return null;
        };

        // getByRole('button', { name: 'Submit' }) — handles single or double
        // quotes for the role via the same quote-aware extractor used below.
        if (selector.startsWith("getByRole(")) {
            const role = extractArg(selector, "getByRole(");
            if (role === null) return page.locator(selector);
            const nameMatch = selector.match(/name:\s*['"](.+?)['"]\s*\}/);
            if (nameMatch) {
                return page.getByRole(role as any, {
                    name: nameMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"'),
                });
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
     * All scopes an interaction may target: the main frame first, then every
     * child frame. Capture is frame-aware, so interaction must be too —
     * otherwise a field/button inside an iframe is shown to the agent but can
     * never be filled or clicked (a silent "it didn't enter the input").
     */
    private interactionScopes(): Array<import("playwright").Page | import("playwright").Frame> {
        const main = this.page!.mainFrame();
        const children = this.page!.frames().filter((f) => f !== main);
        return [this.page!, ...children];
    }

    /**
     * Run an action against a locator, retrying with `.first()` when the
     * selector matched multiple elements (Playwright strict-mode violation).
     * Ambiguous accessible names (two "Email" textboxes, a shared
     * `input[type=password]`) would otherwise abort the whole fill.
     */
    private async runActionWithStrictRetry(
        locator: import("playwright").Locator,
        fn: (locator: import("playwright").Locator) => Promise<void>,
    ): Promise<void> {
        try {
            await fn(locator);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/strict mode violation|resolved to \d+ element/i.test(msg)) {
                // The selector matched multiple elements. Instead of blindly
                // acting on `.first()` (which is often the wrong, hidden, or
                // template element and produces a false "success"), act on the
                // first *visible* match. Only if none are visible do we fall
                // back to the first.
                const count = await locator.count().catch(() => 0);
                for (let i = 0; i < count; i++) {
                    const candidate = locator.nth(i);
                    const visible = await candidate.isVisible().catch(() => false);
                    if (visible) {
                        console.warn(
                            `  ⚠ selector matched ${count} elements; acting on first visible (index ${i})`,
                        );
                        await fn(candidate);
                        return;
                    }
                }
                await fn(locator.first());
                return;
            }
            throw error;
        }
    }

    /**
     * Run an action against one or more selectors, trying each selector across
     * every frame and returning on the first success. A cheap `count()` guard
     * skips scopes where the selector doesn't exist so we don't pay a full
     * action timeout per empty frame.
     */
    private async runWithSelectors(
        action: string,
        selectors: string | string[],
        fn: (locator: import("playwright").Locator) => Promise<void>,
    ): Promise<void> {
        this.ensureActive();
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const element = list[0] || "unknown";
        console.log(
            `  ${action}: ${element}${list.length > 1 ? ` (+${list.length - 1} alternatives)` : ""}`,
        );
        const scopes = this.interactionScopes();
        let lastError: unknown;
        const failed: string[] = [];
        for (const sel of list) {
            let attemptedSomewhere = false;
            for (const scope of scopes) {
                let locator: import("playwright").Locator;
                try {
                    locator = this.resolveLocator(sel, scope);
                } catch (error) {
                    lastError = error;
                    continue;
                }
                // Skip frames that don't contain this selector (fast, no wait).
                let count = 0;
                try {
                    count = await locator.count();
                } catch {
                    count = 0;
                }
                if (count === 0) continue;
                attemptedSomewhere = true;
                try {
                    await this.runActionWithStrictRetry(locator, fn);
                    for (const bad of failed) {
                        this.reportSelectorFailure(element, bad);
                    }
                    this.reportSelectorSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            // If the selector matched nothing in any frame, still attempt it once
            // on the main frame so its natural wait/error surfaces meaningfully.
            if (!attemptedSomewhere) {
                try {
                    await this.runActionWithStrictRetry(this.resolveLocator(sel, this.page!), fn);
                    for (const bad of failed) {
                        this.reportSelectorFailure(element, bad);
                    }
                    this.reportSelectorSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            failed.push(sel);
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
        await this.runWithSelectors("type", selectors, (loc) =>
            loc.pressSequentially(text, { timeout: this.actionTimeoutMs() }),
        );
    }

    /**
     * Press a key
     */
    async press(key: string): Promise<void> {
        this.ensureActive();
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
        await this.runWithSelectors("selectOption", selectors, async (loc) => {
            await loc.selectOption(value, { timeout: this.actionTimeoutMs() });
        });
    }

    /**
     * Check a checkbox
     */
    async check(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("check", selectors, (loc) =>
            loc.check({ timeout: this.actionTimeoutMs() }),
        );
    }

    /**
     * Uncheck a checkbox
     */
    async uncheck(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("uncheck", selectors, (loc) =>
            loc.uncheck({ timeout: this.actionTimeoutMs() }),
        );
    }

    /**
     * Hover over an element
     */
    async hover(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("hover", selectors, (loc) =>
            loc.hover({ timeout: this.actionTimeoutMs() }),
        );
    }

    /**
     * Focus an element
     */
    async focus(selectors: string | string[]): Promise<void> {
        await this.runWithSelectors("focus", selectors, (loc) =>
            loc.focus({ timeout: this.actionTimeoutMs() }),
        );
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
        const effectiveTimeout = timeout || this.options.timeout;
        const scopes = this.interactionScopes();
        let lastError: unknown;
        const failed: string[] = [];

        // Fast path: if a selector is already present in some frame, wait on it there.
        for (const sel of list) {
            for (const scope of scopes) {
                let locator: import("playwright").Locator;
                try {
                    locator = this.resolveLocator(sel, scope);
                } catch (error) {
                    lastError = error;
                    continue;
                }
                let count = 0;
                try {
                    count = await locator.count();
                } catch {
                    count = 0;
                }
                if (count === 0) continue;
                try {
                    await locator.first().waitFor({ state: "visible", timeout: effectiveTimeout });
                    for (const bad of failed) {
                        this.reportSelectorFailure(element, bad);
                    }
                    this.reportSelectorSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            failed.push(sel);
        }

        // Nothing present yet: fall back to waiting on the main frame for the
        // first selector so "wait until it appears" still holds.
        try {
            await this.resolveLocator(list[0], this.page!).first().waitFor({
                state: "visible",
                timeout: effectiveTimeout,
            });
            this.reportSelectorSuccess(element, list[0]);
            return;
        } catch (error) {
            lastError = error;
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
        await this.page!.waitForLoadState("networkidle", { timeout: timeout || 5000 });
    }

    /**
     * Best-effort settle after an interaction: wait for the network to go idle
     * and for real interactive content to render before the caller captures the
     * page. Both steps fail open (client frameworks mount asynchronously, so we
     * must never block a capture on them). Use this before `captureCurrentPage`
     * on the post-action path so the agent reasons against the settled DOM
     * rather than a transient/empty shell.
     */
    async settle(): Promise<boolean> {
        if (!this.isActive()) return false;
        const idle = await this.waitForIdle();
        await this.waitForContent();
        return idle;
    }

    /**
     * Wait for a fixed amount of time
     */
    async wait(ms: number): Promise<void> {
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
                        return await this.capturePageInternal();
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

    private async capturePageInternal(): Promise<DOMContext> {
        const url = this.page!.url();
        const title = await this.page!.title();

        // One extraction pass across all frames, then derive both views in Node.
        const raw = await this.collectRawElements();
        const interactiveElements = this.toInteractiveElements(raw);
        const formFields = this.toFormFields(raw);

        const accessibilityTree = this.buildSimpleTree(title, interactiveElements, formFields);
        const performance = await this.capturePagePerformance();

        return {
            url,
            title,
            accessibilityTree,
            interactiveElements,
            formFields,
            timestamp: Date.now(),
            performance,
        };
    }

    /**
     * Take a screenshot
     */
    async screenshot(): Promise<Buffer> {
        this.ensureActive();
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

        const currentUrl = new URL(this.page!.url());
        const currentOrigin = currentUrl.origin;
        const discovered: Array<{
            text: string;
            href: string;
            isExternal: boolean;
            suggestedSelectors: string[];
        }> = [];
        const seenHrefs = new Set<string>();

        const addLink = (text: string, href: string, suggestedSelectors: string[]) => {
            if (
                !href ||
                href.startsWith("#") ||
                href.startsWith("javascript:") ||
                href === "about:blank"
            )
                return;
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
                const selectors = this.buildSelectors("link", ariaLabel || text, testId, {
                    htmlId: htmlId || undefined,
                    ariaLabel: ariaLabel || undefined,
                });
                addLink(text, href || "", selectors);
            } catch {
                /* inaccessible */
            }
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
            } catch {
                /* inaccessible */
            }
        }

        // 3. SPA-aware: clickable navigation elements inside <nav>
        //    Many SPAs use <button> or <div> inside <nav> for client-side routing
        const navClickables = await this.page!.locator(
            'nav button, nav [role="button"], nav [role="tab"], nav [role="menuitem"]',
        ).all();
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
            } catch {
                /* inaccessible */
            }
        }

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
        await this.context!.storageState({ path });
    }

    /**
     * Load auth state from file
     */
    async loadAuthState(path: string): Promise<void> {
        if (!this.browser) {
            throw new Error("Browser not started. Call start() first.");
        }

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
                '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]',
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
            this.selectorMemory.recordSuccess(element, selector, classifySelector(selector));
        } catch {
            // Memory must never break a browser action.
        }
    }

    private reportSelectorFailure(element: string, selector: string): void {
        if (!this.selectorMemory) return;
        try {
            this.selectorMemory.recordFailure(element, selector, classifySelector(selector));
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
            // Include every distinguishing attribute so genuinely different
            // controls (two "Submit" buttons, two "Settings" links pointing at
            // different hrefs) survive. Only collapse elements that are truly
            // indistinguishable — a selector could not tell those apart anyway.
            const key = [
                el.role || "",
                el.name || "",
                el.testId || "",
                el.tagName,
                el.type || "",
                el.href || "",
                el.htmlId || "",
                el.htmlName || "",
                el.placeholder || "",
            ].join("|");
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

    /**
     * Extract every interesting element across all frames in a single
     * `evaluate` per frame. This replaces the old per-element Playwright calls
     * (hundreds of round-trips → slow/flaky/truncated captures) with one DOM
     * walk per frame that also computes proper accessible names (aria-label,
     * aria-labelledby, associated/ wrapping <label>) and picks up non-semantic
     * clickables (onclick / tabindex) that the old scan missed entirely.
     */
    private async collectRawElements(): Promise<RawElement[]> {
        const collected: RawElement[] = [];
        const MAX_TOTAL = 160;

        for (const frame of this.getAllFrames()) {
            try {
                const els = await this.extractRawFromFrame(frame, MAX_TOTAL - collected.length);
                collected.push(...els);
            } catch {
                continue;
            }
            if (collected.length >= MAX_TOTAL) break;
        }

        return collected;
    }

    private async extractRawFromFrame(
        scope: import("playwright").Frame,
        limit: number,
    ): Promise<RawElement[]> {
        if (limit <= 0) return [];
        return scope.evaluate((maxCount: number): RawElement[] => {
            const SELECTOR = [
                "button",
                '[role="button"]',
                'input[type="submit"]',
                'input[type="button"]',
                "a[href]",
                '[role="link"]',
                'input:not([type="hidden"])',
                "textarea",
                "select",
                '[contenteditable="true"]',
                '[role="checkbox"]',
                '[role="radio"]',
                '[role="switch"]',
                '[role="tab"]',
                '[role="menuitem"]',
                '[role="option"]',
                '[role="combobox"]',
                '[role="textbox"]',
                "[onclick]",
                '[tabindex]:not([tabindex="-1"])',
            ].join(",");

            const isVisible = (el: Element): boolean => {
                const rects = el.getClientRects();
                if (rects.length === 0) return false;
                const style = window.getComputedStyle(el);
                if (
                    style.visibility === "hidden" ||
                    style.display === "none" ||
                    style.opacity === "0"
                ) {
                    return false;
                }
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };

            const accessibleName = (el: Element): string => {
                const aria = el.getAttribute("aria-label");
                if (aria?.trim()) return aria.trim();
                const labelledby = el.getAttribute("aria-labelledby");
                if (labelledby) {
                    const txt = labelledby
                        .split(/\s+/)
                        .map((id) => document.getElementById(id)?.textContent || "")
                        .join(" ")
                        .trim();
                    if (txt) return txt;
                }
                const id = el.getAttribute("id");
                if (id) {
                    try {
                        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                        if (lab?.textContent?.trim()) return lab.textContent.trim();
                    } catch {
                        /* invalid id for selector */
                    }
                }
                const wrap = el.closest("label");
                if (wrap?.textContent?.trim()) return wrap.textContent.trim();
                const text = (el.textContent || "").replace(/\s+/g, " ").trim();
                if (text) return text;
                const ph = el.getAttribute("placeholder");
                if (ph?.trim()) return ph.trim();
                const title = el.getAttribute("title");
                if (title?.trim()) return title.trim();
                const val = (el as HTMLInputElement).value;
                if (typeof val === "string" && val.trim()) return val.trim();
                const alt = el.getAttribute("alt");
                if (alt?.trim()) return alt.trim();
                return "";
            };

            const computeRole = (el: Element, tag: string, type: string | null): string => {
                const explicit = el.getAttribute("role");
                if (explicit) return explicit;
                if (tag === "a") return "link";
                if (tag === "button") return "button";
                if (tag === "textarea") return "textbox";
                if (tag === "select") return "combobox";
                if (tag === "input") {
                    const t = (type || "text").toLowerCase();
                    if (t === "checkbox") return "checkbox";
                    if (t === "radio") return "radio";
                    if (t === "range") return "slider";
                    if (t === "submit" || t === "button" || t === "reset") return "button";
                    return "textbox";
                }
                if (el.hasAttribute("contenteditable")) return "textbox";
                return "button";
            };

            const out: RawElement[] = [];
            const nodes = Array.from(document.querySelectorAll(SELECTOR));
            for (const el of nodes) {
                if (out.length >= maxCount) break;
                if (!isVisible(el)) continue;
                const tag = el.tagName.toLowerCase();
                const type = el.getAttribute("type");
                const role = computeRole(el, tag, type);
                const name = accessibleName(el);
                const isFormField =
                    (tag === "input" &&
                        !["submit", "button", "reset", "hidden"].includes(
                            (type || "text").toLowerCase(),
                        )) ||
                    tag === "textarea" ||
                    tag === "select" ||
                    el.getAttribute("contenteditable") === "true";
                out.push({
                    tag,
                    role,
                    name: name.slice(0, 200),
                    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
                    type,
                    testId: el.getAttribute("data-testid"),
                    htmlId: el.getAttribute("id"),
                    htmlName: el.getAttribute("name"),
                    href: el.getAttribute("href"),
                    placeholder: el.getAttribute("placeholder"),
                    ariaLabel: el.getAttribute("aria-label"),
                    required: el.hasAttribute("required"),
                    isFormField,
                });
            }
            return out;
        }, limit);
    }

    /** Map raw descriptors → InteractiveElement[] with Node-built selectors. */
    private toInteractiveElements(raw: RawElement[]): InteractiveElement[] {
        const elements: InteractiveElement[] = raw.map((el) => {
            const displayName = el.name || el.text || el.href || "";
            return {
                tagName: el.tag,
                role: el.role,
                text: el.text,
                name: displayName,
                type: el.type || undefined,
                testId: el.testId || undefined,
                htmlName: el.htmlName || undefined,
                htmlId: el.htmlId || undefined,
                href: el.href || undefined,
                placeholder: el.placeholder || undefined,
                ariaLabel: el.ariaLabel || undefined,
                suggestedSelectors: this.buildSelectors(el.role, displayName, el.testId, {
                    htmlName: el.htmlName || undefined,
                    htmlId: el.htmlId || undefined,
                    placeholder: el.placeholder || undefined,
                    ariaLabel: el.ariaLabel || undefined,
                    type: el.type || undefined,
                }),
            };
        });
        return this.dedupeElements(elements).slice(0, 80);
    }

    /** Map raw descriptors → FormField[] for the text-entry controls. */
    private toFormFields(raw: RawElement[]): FormField[] {
        const fields: FormField[] = raw
            .filter((el) => el.isFormField)
            .map((el) => {
                const type =
                    el.type ||
                    (el.tag === "textarea" ? "textarea" : el.tag === "select" ? "select" : "text");
                return {
                    name: el.ariaLabel || el.placeholder || el.htmlName || el.htmlId || el.name,
                    type,
                    label: el.ariaLabel || undefined,
                    placeholder: el.placeholder || undefined,
                    required: el.required,
                    id: el.htmlId || undefined,
                    suggestedSelector: buildFieldSelector({
                        testId: el.testId || undefined,
                        id: el.htmlId || undefined,
                        name: el.htmlName || undefined,
                        label: el.ariaLabel || undefined,
                        placeholder: el.placeholder || undefined,
                    }),
                };
            });
        return this.dedupeFields(fields).slice(0, 60);
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

    private async waitForIdle(): Promise<boolean> {
        try {
            await this.page!.waitForLoadState("networkidle", { timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wait until the page has rendered real, interactive content. Client-side
     * frameworks (React/Vue/Angular) mount *after* `domcontentloaded` and often
     * after `networkidle`, so capturing immediately yields an empty shell — the
     * root cause of "some pages' DOMs are not discovered". We poll (bounded)
     * until at least one interactive control exists or the body has meaningful
     * text, and fail open so a genuinely empty page still proceeds.
     */
    private async waitForContent(): Promise<void> {
        try {
            await this.page!.waitForFunction(
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

    /**
     * Start recording per-response timings on the current page. Returns a
     * `stop()` function that detaches the listener and returns the slowest
     * responses seen since it was started. Used to give the test generator a
     * concrete picture of which requests are slow on the page under test.
     */
    private collectResponseTimings(): () => PagePerformance["slowResponses"] {
        const page = this.page;
        if (!page) return () => undefined;

        const records: Array<{ url: string; status: number; durationMs: number }> = [];
        const handler = (response: import("playwright").Response) => {
            try {
                // `responseEnd` is the resource duration in ms (or -1 when the
                // browser didn't record it, e.g. served from cache).
                const durationMs = response.request().timing().responseEnd;
                if (Number.isFinite(durationMs) && durationMs > 0) {
                    records.push({
                        url: response.url(),
                        status: response.status(),
                        durationMs,
                    });
                }
            } catch {
                // Response/request may be gone; skip it.
            }
        };

        page.on("response", handler);

        return () => {
            try {
                page.off("response", handler);
            } catch {
                // page may be closed; nothing to detach
            }
            if (records.length === 0) return undefined;
            return records.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
        };
    }

    /**
     * Read Navigation Timing from the live page and fold in the wall-clock
     * measurements captured during the last navigation. Returns `undefined`
     * when no useful signal is available (e.g. about:blank).
     */
    private async capturePagePerformance(): Promise<PagePerformance | undefined> {
        const perf: PagePerformance = {};

        try {
            const nav = await this.page!.evaluate(() => {
                const entry = performance.getEntriesByType("navigation")[0] as
                    | PerformanceNavigationTiming
                    | undefined;
                if (!entry) return null;
                return {
                    domContentLoadedMs: entry.domContentLoadedEventEnd,
                    loadEventMs: entry.loadEventEnd,
                    ttfbMs: entry.responseStart - entry.requestStart,
                };
            });
            if (nav) {
                if (nav.domContentLoadedMs > 0) perf.domContentLoadedMs = nav.domContentLoadedMs;
                if (nav.loadEventMs > 0) perf.loadEventMs = nav.loadEventMs;
                if (nav.ttfbMs >= 0) perf.ttfbMs = nav.ttfbMs;
            }
        } catch {
            // evaluate can fail on restricted pages; fall back to wall-clock only
        }

        if (this.lastNavigationMs !== undefined) perf.navigationMs = this.lastNavigationMs;
        if (this.lastNetworkIdle !== undefined) perf.networkIdle = this.lastNetworkIdle;
        if (this.lastSlowResponses && this.lastSlowResponses.length > 0) {
            perf.slowResponses = this.lastSlowResponses;
        }

        return Object.keys(perf).length > 0 ? perf : undefined;
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
        htmlAttrs?: {
            htmlName?: string;
            htmlId?: string;
            placeholder?: string;
            ariaLabel?: string;
            type?: string;
        },
    ): string[] {
        const selectors: string[] = [];
        const esc = (s: string) => s.replace(/'/g, "\\'");
        // Escape CSS-special characters in an id so framework-generated ids
        // (React ":r1:", Angular/Material "mat-input-0.5", Tailwind "input:focus")
        // produce valid `#id` selectors instead of silently matching nothing.
        const escId = (s: string) => s.replace(/([ "\\#.:>~+*[\](){}!,'^$|=@%&?/;])/g, "\\$1");
        const isInput =
            role === "textbox" ||
            role === "combobox" ||
            role === "checkbox" ||
            role === "radio" ||
            role === "slider";
        const isButton = role === "button";

        // data-testid: most stable, framework-provided
        if (testId) selectors.push(`getByTestId('${esc(testId)}')`);

        // CSS from HTML attributes: direct, unambiguous
        if (htmlAttrs) {
            if (isInput && htmlAttrs.htmlName) {
                selectors.push(`input[name="${htmlAttrs.htmlName}"]`);
            }
            if (isInput && htmlAttrs.htmlId) {
                selectors.push(`#${escId(htmlAttrs.htmlId)}`);
            }
            if ((isButton || role === "link") && htmlAttrs.htmlId) {
                selectors.push(`#${escId(htmlAttrs.htmlId)}`);
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
        fields: FormField[],
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
