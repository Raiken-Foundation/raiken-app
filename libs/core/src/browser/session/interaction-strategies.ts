/**
 * Non-native ARIA combobox and form-field interaction strategies.
 * Owns combobox detection, popup location, and fill/select fallbacks.
 */

import type { Frame, Locator, Page } from "playwright";

export interface InteractionStrategyContext {
    getPage(): Page;
    actionTimeoutMs(): number;
    wait(ms: number): Promise<void>;
    escapeCssId(s: string): string;
}

export class InteractionStrategies {
    constructor(private readonly ctx: InteractionStrategyContext) {}

    /**
     * Detect and drive a non-native ARIA combobox. Returns false when the
     * element isn't recognized so the caller falls through to plain fill/select.
     */
    async tryAriaComboboxSelect(loc: Locator, value: string): Promise<boolean> {
        const meta = await loc
            .evaluate((el) => {
                const e = el as HTMLElement;
                return {
                    tag: e.tagName.toLowerCase(),
                    role: e.getAttribute("role"),
                    haspopup: e.getAttribute("aria-haspopup"),
                    autocomplete: e.getAttribute("aria-autocomplete"),
                    controls: e.getAttribute("aria-controls") || e.getAttribute("aria-owns"),
                    expanded: e.getAttribute("aria-expanded"),
                    isContentEditable: e.isContentEditable,
                };
            })
            .catch(() => null);
        if (!meta || meta.tag === "select") return false;

        const isCombobox =
            meta.role === "combobox" ||
            meta.haspopup === "listbox" ||
            (!!meta.autocomplete && meta.autocomplete !== "none") ||
            (!!meta.controls && meta.expanded !== null);
        if (!isCombobox) return false;

        const preOpenListboxes = await this.countVisibleListboxes();

        try {
            await loc.click({ timeout: this.ctx.actionTimeoutMs() });
        } catch {
            await loc.focus().catch(() => undefined);
        }

        const popup = await this.locateComboboxPopup(meta.controls, preOpenListboxes);
        if (!popup) return false;

        if (meta.tag === "input" || meta.tag === "textarea" || meta.isContentEditable) {
            await loc
                .pressSequentially(value, { timeout: this.ctx.actionTimeoutMs() })
                .catch(() => undefined);
        }

        const option = await this.findComboboxOption(popup, value);
        if (!option) return false;

        try {
            await option.click({ timeout: this.ctx.actionTimeoutMs() });
        } catch {
            return false;
        }
        return true;
    }

    /** Fill with combobox-first, then native fill, then selectOption for <select>. */
    async fillField(loc: Locator, value: string): Promise<void> {
        if (await this.tryAriaComboboxSelect(loc, value)) return;
        try {
            await loc.fill(value, { timeout: this.ctx.actionTimeoutMs() });
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
    }

    /** selectOption with combobox-first fallback for native selects. */
    async selectField(loc: Locator, value: string): Promise<void> {
        if (await this.tryAriaComboboxSelect(loc, value)) return;
        await loc.selectOption(value, { timeout: this.ctx.actionTimeoutMs() });
    }

    private async countVisibleListboxes(): Promise<number> {
        const listbox = this.ctx.getPage().locator('[role="listbox"]');
        const count = await listbox.count().catch(() => 0);
        let visible = 0;
        for (let i = 0; i < count; i++) {
            if (
                await listbox
                    .nth(i)
                    .isVisible()
                    .catch(() => false)
            ) {
                visible++;
            }
        }
        return visible;
    }

    private async locateComboboxPopup(
        controlsId: string | null,
        preOpenVisibleListboxes = 0,
    ): Promise<Locator | null> {
        const page = this.ctx.getPage();
        const firstId = controlsId?.split(/\s+/).find((id) => id.length > 0) ?? null;

        if (firstId) {
            const byId = page.locator(`#${this.ctx.escapeCssId(firstId)}`);
            if (await byId.count().catch(() => 0)) {
                try {
                    await byId.first().waitFor({ state: "visible", timeout: 2000 });
                    return byId.first();
                } catch {
                    return null;
                }
            }
        }

        const deadline = Date.now() + 2000;
        do {
            const listbox = page.locator('[role="listbox"]');
            const count = await listbox.count().catch(() => 0);
            const visible: Locator[] = [];
            for (let i = 0; i < count; i++) {
                const candidate = listbox.nth(i);
                if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
            }
            if (visible.length > preOpenVisibleListboxes) {
                return visible[visible.length - 1];
            }
            await this.ctx.wait(100);
        } while (Date.now() < deadline);
        return null;
    }

    private async findComboboxOption(popup: Locator, value: string): Promise<Locator | null> {
        const exact = popup.getByRole("option", { name: value, exact: true });
        if (await exact.count().catch(() => 0)) return exact.first();

        const byRole = popup.getByRole("option", { name: value });
        if (await byRole.count().catch(() => 0)) return byRole.first();

        const byText = popup.getByText(value, { exact: false });
        if (await byText.count().catch(() => 0)) return byText.first();

        return null;
    }
}

/** Escape a value for interpolation into a CSS id selector. */
export function escapeCssId(s: string): string {
    return s.replace(/([ "\\#.:>~+*[\](){}!,'^$|=@%&?/;])/g, "\\$1");
}

/** All scopes an interaction may target: main frame first, then child frames. */
export function interactionScopes(page: Page): Array<Page | Frame> {
    const main = page.mainFrame();
    const children = page.frames().filter((f) => f !== main);
    return [page, ...children];
}
