/**
 * Locator resolution, selector fallback ordering, and strict-mode retry policy.
 * Injected with Page access and optional selector-memory hooks.
 */

import type { Frame, Locator, Page } from "playwright";
import { interactionScopes } from "./interaction-strategies";
import { classifySelector } from "./selector-utils";
import type { AriaRole, SelectorKind } from "./types";

export interface SelectorMemoryHooks {
    recordSuccess(element: string, selector: string, kind: SelectorKind): void;
    recordFailure(element: string, selector: string, kind: SelectorKind): void;
}

export interface LocatorResolverContext {
    getPage(): Page;
    getDefaultTimeout(): number;
    selectorMemory: SelectorMemoryHooks | null;
}

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
 * Turn a selector string into a Playwright Locator.
 * Supports role=, text=, label=, getByRole/getByText/..., and plain CSS.
 */
export function resolveLocator(selector: string, scope: Page | Frame): Locator {
    const page = scope;

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

    if (selector.startsWith("getByRole(")) {
        const role = extractArg(selector, "getByRole(");
        if (role === null) return page.locator(selector);
        const nameMatch = selector.match(/name:\s*['"](.+?)['"]\s*\}/);
        if (nameMatch) {
            return page.getByRole(role as AriaRole, {
                name: nameMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"'),
            });
        }
        return page.getByRole(role as AriaRole);
    }

    const testIdArg = extractArg(selector, "getByTestId(");
    if (testIdArg !== null) return page.getByTestId(testIdArg);

    const labelArg = extractArg(selector, "getByLabel(");
    if (labelArg !== null) return page.getByLabel(labelArg);

    const placeholderArg = extractArg(selector, "getByPlaceholder(");
    if (placeholderArg !== null) return page.getByPlaceholder(placeholderArg);

    const textArg = extractArg(selector, "getByText(");
    if (textArg !== null) return page.getByText(textArg);

    const roleMatch = selector.match(/^role=(\w+)\[name="(.+?)"\]/);
    if (roleMatch) {
        return page.getByRole(roleMatch[1] as AriaRole, { name: roleMatch[2] });
    }

    if (selector.startsWith("text=")) return page.getByText(selector.slice(5));
    if (selector.startsWith("label=")) return page.getByLabel(selector.slice(6));
    if (selector.startsWith("placeholder=")) return page.getByPlaceholder(selector.slice(12));

    return page.locator(selector);
}

export class LocatorResolver {
    constructor(private readonly ctx: LocatorResolverContext) {}

    resolve(selector: string, scope?: Page | Frame): Locator {
        return resolveLocator(selector, scope ?? this.ctx.getPage());
    }

    scopes(): Array<Page | Frame> {
        return interactionScopes(this.ctx.getPage());
    }

    /**
     * Run an action against one or more selectors, trying each across every
     * frame and returning on the first success.
     */
    async runWithSelectors(
        action: string,
        selectors: string | string[],
        fn: (locator: Locator) => Promise<void>,
    ): Promise<void> {
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const element = list[0] || "unknown";
        // stderr, not stdout: this is a diagnostic, and `--json` modes promise
        // that stdout is machine-clean JSON and nothing else.
        console.error(
            `  ${action}: ${element}${list.length > 1 ? ` (+${list.length - 1} alternatives)` : ""}`,
        );
        const scopes = this.scopes();
        let lastError: unknown;
        const failed: string[] = [];
        for (const sel of list) {
            let attemptedSomewhere = false;
            for (const scope of scopes) {
                let locator: Locator;
                try {
                    locator = this.resolve(sel, scope);
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
                attemptedSomewhere = true;
                try {
                    await this.runActionWithStrictRetry(locator, fn);
                    for (const bad of failed) {
                        this.reportFailure(element, bad);
                    }
                    this.reportSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!attemptedSomewhere) {
                try {
                    await this.runActionWithStrictRetry(this.resolve(sel, this.ctx.getPage()), fn);
                    for (const bad of failed) {
                        this.reportFailure(element, bad);
                    }
                    this.reportSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            failed.push(sel);
        }
        for (const bad of failed) {
            this.reportFailure(element, bad);
        }
        throw new BrowserActionError(action, element, lastError);
    }

    async waitForSelector(selectors: string | string[], timeout?: number): Promise<void> {
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const element = list[0] || "unknown";
        const effectiveTimeout = timeout ?? this.ctx.getDefaultTimeout();
        const scopes = this.scopes();
        let lastError: unknown;
        const failed: string[] = [];

        for (const sel of list) {
            for (const scope of scopes) {
                let locator: Locator;
                try {
                    locator = this.resolve(sel, scope);
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
                        this.reportFailure(element, bad);
                    }
                    this.reportSuccess(element, sel);
                    return;
                } catch (error) {
                    lastError = error;
                }
            }
            failed.push(sel);
        }

        try {
            await this.resolve(list[0], this.ctx.getPage()).first().waitFor({
                state: "visible",
                timeout: effectiveTimeout,
            });
            this.reportSuccess(element, list[0]);
            return;
        } catch (error) {
            lastError = error;
        }

        for (const bad of failed) {
            this.reportFailure(element, bad);
        }
        throw new BrowserActionError("waitForSelector", element, lastError);
    }

    private async runActionWithStrictRetry(
        locator: Locator,
        fn: (locator: Locator) => Promise<void>,
    ): Promise<void> {
        try {
            await fn(locator);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/strict mode violation|resolved to \d+ element/i.test(msg)) {
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

    private reportSuccess(element: string, selector: string): void {
        if (!this.ctx.selectorMemory) return;
        try {
            this.ctx.selectorMemory.recordSuccess(element, selector, classifySelector(selector));
        } catch {
            // Memory must never break a browser action.
        }
    }

    private reportFailure(element: string, selector: string): void {
        if (!this.ctx.selectorMemory) return;
        try {
            this.ctx.selectorMemory.recordFailure(element, selector, classifySelector(selector));
        } catch {
            // Memory must never break a browser action.
        }
    }
}
