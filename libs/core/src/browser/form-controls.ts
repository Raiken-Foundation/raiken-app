import type { Page } from "playwright";

/**
 * One in-page collector for form controls and their accessible names.
 *
 * Discovery (`extractPageForms`) mints facts from these labels; the contract
 * verifier (`checkObservable`) re-observes facts against them. Before this
 * module existed the two halves each had their own label logic — discovery
 * computed real accessible names while verify matched raw `placeholder |
 * aria-label | name` attributes, so any form labeled the accessible way
 * (`<label for>`, wrapping labels, `aria-labelledby`) minted a fact verify
 * could never re-find. Both sides now consume this collector, so mint and
 * verify cannot drift again.
 *
 * `collectFormControls` must stay fully self-contained (no imports, no
 * references to module scope): it is serialized into the browser by
 * `page.evaluate`. Shape/caps live in the callers.
 */

export interface CollectedFormField {
    /** Accessible name per the ladder below; never empty when a control is visible. */
    label: string;
    tag: string;
    type: string;
    required: boolean;
    placeholder?: string;
    name?: string;
    id?: string;
    testId?: string;
}

export interface CollectedFormControls {
    fields: CollectedFormField[];
    /** Accessible names of visible button-like elements, in DOM order. */
    submits: string[];
}

/**
 * Accessible-name ladder, aligned with ACCNAME's precedence and with the
 * pragmatics of a test-targeting tool:
 *   `aria-labelledby` → `aria-label` → `<label for>` → wrapping `<label>`
 *   → `placeholder` → `name`
 * (`placeholder`/`name` are not real accessible names, but they remain the
 * last-resort haystack so unlabeled legacy forms are still addressable.)
 */
export function collectFormControls(): CollectedFormControls {
    const isVisible = (el: Element): boolean => {
        const he = el as HTMLElement;
        if (he.hidden) return false;
        const style = window.getComputedStyle(he);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return he.offsetParent !== null || style.position === "fixed";
    };

    const textOfIdRefs = (value: string): string =>
        value
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
            .trim();

    const labelFor = (el: Element): string => {
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
            const text = textOfIdRefs(labelledby);
            if (text) return text;
        }
        const aria = el.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const id = (el as HTMLInputElement).id;
        if (id) {
            const escaped =
                typeof CSS !== "undefined" && CSS.escape
                    ? CSS.escape(id)
                    : id.replace(/"/g, '\\"');
            const label = document.querySelector(`label[for="${escaped}"]`);
            if (label?.textContent?.trim()) return label.textContent.trim();
        }
        const wrapping = el.closest("label");
        if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
        return (el.getAttribute("placeholder") || el.getAttribute("name") || "").trim();
    };

    const buttonName = (el: Element): string => {
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
            const text = textOfIdRefs(labelledby);
            if (text) return text;
        }
        const aria = el.getAttribute("aria-label");
        if (aria?.trim()) return aria.trim();
        const text = (el.textContent || el.getAttribute("value") || "").trim();
        if (text) return text;
        return (el.getAttribute("title") || "").trim();
    };

    const fields: CollectedFormField[] = Array.from(
        document.querySelectorAll("input, select, textarea"),
    )
        .filter((el) => {
            const type = (el.getAttribute("type") || "").toLowerCase();
            if (type === "hidden") return false;
            return isVisible(el);
        })
        .map((el) => {
            const tag = el.tagName.toLowerCase();
            return {
                label: labelFor(el),
                tag,
                type: (el.getAttribute("type") || tag).toLowerCase(),
                required:
                    el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
                placeholder: el.getAttribute("placeholder") || undefined,
                name: el.getAttribute("name") || undefined,
                id: (el as HTMLInputElement).id || undefined,
                testId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || undefined,
            };
        });

    const submits: string[] = Array.from(
        document.querySelectorAll(
            "button, input[type=submit], input[type=button], [role=button]",
        ),
    )
        .filter((el) => isVisible(el))
        .map(buttonName)
        .filter((text) => text.length > 0);

    return { fields, submits };
}

/** Read form controls with accessible names from a live page. */
export async function readFormControls(page: Page): Promise<CollectedFormControls> {
    return page.evaluate(collectFormControls);
}
