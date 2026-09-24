/**
 * DOM snapshot, accessibility tree, interactive element extraction,
 * and page metadata capture. Reuses dom-capture type definitions.
 */

import type { Frame, Locator, Page } from "playwright";
import type {
    AccessibilityNode,
    DOMContext,
    FormField,
    InteractiveElement,
    PagePerformance,
} from "../dom-capture";
import { buildFieldSelector, buildSelectors } from "./selector-utils";
import type { RawElement } from "./types";

export interface NavigationPerformanceSignals {
    lastNavigationMs?: number;
    lastNetworkIdle?: boolean;
    lastSlowResponses?: PagePerformance["slowResponses"];
}

export interface DomSnapshotBuilderContext {
    getPage(): Page;
    getPerformanceSignals(): NavigationPerformanceSignals;
}

export class DomSnapshotBuilder {
    constructor(private readonly ctx: DomSnapshotBuilderContext) {}

    async capture(): Promise<DOMContext> {
        const page = this.ctx.getPage();
        const url = page.url();
        const title = await page.title();

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
     * Discover all links on the current page (lightweight, no full DOM capture).
     */
    async discoverLinks(): Promise<
        Array<{
            text: string;
            href: string;
            isExternal: boolean;
            suggestedSelectors: string[];
        }>
    > {
        const page = this.ctx.getPage();
        const currentUrl = new URL(page.url());
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
            ) {
                return;
            }
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

        const anchorLinks = await page.locator("a[href]").all();
        for (const link of anchorLinks.slice(0, 100)) {
            try {
                const href = await link.getAttribute("href");
                const text = ((await link.textContent()) || "").trim();
                const testId = await link.getAttribute("data-testid");
                const ariaLabel = await link.getAttribute("aria-label");
                const htmlId = await link.getAttribute("id");
                const selectors = buildSelectors("link", ariaLabel || text, testId, {
                    htmlId: htmlId || undefined,
                    ariaLabel: ariaLabel || undefined,
                });
                addLink(text, href || "", selectors);
            } catch {
                /* inaccessible */
            }
        }

        const roleLinks = await page.locator('[role="link"]:not(a)').all();
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
                const selectors = buildSelectors("link", ariaLabel || text, testId, {
                    htmlId: htmlId || undefined,
                    ariaLabel: ariaLabel || undefined,
                });
                addLink(text, href, selectors);
            } catch {
                /* inaccessible */
            }
        }

        const navClickables = await page
            .locator('nav button, nav [role="button"], nav [role="tab"], nav [role="menuitem"]')
            .all();
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
                const selectors = buildSelectors(role, ariaLabel || text, testId, {
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

    private getAllFrames(): Frame[] {
        const page = this.ctx.getPage();
        const frames = page.frames();
        const main = page.mainFrame();
        const ordered = [main, ...frames.filter((f) => f !== main)];
        const unique = new Set<Frame>();
        const deduped: Frame[] = [];
        for (const frame of ordered) {
            if (!unique.has(frame)) {
                unique.add(frame);
                deduped.push(frame);
            }
        }
        return deduped;
    }

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

    private async extractRawFromFrame(scope: Frame, limit: number): Promise<RawElement[]> {
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
                "dialog",
                '[role="dialog"]',
                '[role="alertdialog"]',
                '[aria-modal="true"]',
            ].join(",");

            const LANDMARK_ROLES = new Set(["dialog", "alertdialog"]);

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
                // `value` is only an accessible name for push buttons. On text
                // inputs it is whatever the user typed, so using it here would
                // leak credentials into selectors and generated specs.
                if (el.tagName.toLowerCase() === "input") {
                    const inputType = (el.getAttribute("type") || "text").toLowerCase();
                    if (inputType === "submit" || inputType === "button" || inputType === "reset") {
                        const val = (el as HTMLInputElement).value;
                        if (typeof val === "string" && val.trim()) return val.trim();
                    }
                }
                const alt = el.getAttribute("alt");
                if (alt?.trim()) return alt.trim();
                return "";
            };

            const landmarkName = (el: Element): string => {
                const aria = el.getAttribute("aria-label");
                if (aria?.trim()) return aria.trim();
                const labelledby = el.getAttribute("aria-labelledby");
                if (labelledby) {
                    const txt = labelledby
                        .split(/\s+/)
                        .map((id) => document.getElementById(id)?.textContent || "")
                        .join(" ")
                        .replace(/\s+/g, " ")
                        .trim();
                    if (txt) return txt;
                }
                const title = el.getAttribute("title");
                return title?.trim() || "";
            };

            const computeRole = (el: Element, tag: string, type: string | null): string => {
                const explicit = el.getAttribute("role");
                if (explicit) return explicit;
                if (tag === "dialog") return "dialog";
                if (el.getAttribute("aria-modal") === "true") return "dialog";
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
                const isLandmark = LANDMARK_ROLES.has(role);
                const name = isLandmark ? landmarkName(el) : accessibleName(el);
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
                    text: isLandmark
                        ? ""
                        : (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
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
                suggestedSelectors: buildSelectors(el.role, displayName, el.testId, {
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

    private dedupeElements(elements: InteractiveElement[]): InteractiveElement[] {
        const seen = new Set<string>();
        const result: InteractiveElement[] = [];
        for (const el of elements) {
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

    private async capturePagePerformance(): Promise<PagePerformance | undefined> {
        const signals = this.ctx.getPerformanceSignals();
        const perf: PagePerformance = {};

        try {
            const nav = await this.ctx.getPage().evaluate(() => {
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

        if (signals.lastNavigationMs !== undefined) perf.navigationMs = signals.lastNavigationMs;
        if (signals.lastNetworkIdle !== undefined) perf.networkIdle = signals.lastNetworkIdle;
        if (signals.lastSlowResponses && signals.lastSlowResponses.length > 0) {
            perf.slowResponses = signals.lastSlowResponses;
        }

        return Object.keys(perf).length > 0 ? perf : undefined;
    }

    private async isUsableElement(locator: Locator): Promise<boolean> {
        try {
            if (!(await locator.isVisible())) return false;
            const box = await locator.boundingBox();
            if (!box || box.width === 0 || box.height === 0) return false;
            return true;
        } catch {
            return false;
        }
    }
}

/** Start recording per-response timings on the current page. */
export function collectResponseTimings(page: Page | null): () => PagePerformance["slowResponses"] {
    if (!page) return () => undefined;

    const records: Array<{ url: string; status: number; durationMs: number }> = [];
    const handler = (response: import("playwright").Response) => {
        try {
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
