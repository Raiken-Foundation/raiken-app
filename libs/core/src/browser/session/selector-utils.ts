/**
 * Selector classification and construction from observed DOM attributes.
 * Single source of truth for selector strings produced during capture.
 */

import type { SelectorKind } from "./types";

export type { SelectorKind };

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
 * attributes, in decreasing order of robustness.
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
 * Build selectors from the actual DOM attributes of an element.
 * Every selector produced here was derived from a real attribute observed
 * during page capture.
 */
export function buildSelectors(
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
    const escId = (s: string) => s.replace(/([ "\\#.:>~+*[\](){}!,'^$|=@%&?/;])/g, "\\$1");
    const isInput =
        role === "textbox" ||
        role === "combobox" ||
        role === "checkbox" ||
        role === "radio" ||
        role === "slider";
    const isButton = role === "button";
    const isLandmark = role === "dialog" || role === "alertdialog";

    if (testId) selectors.push(`getByTestId('${esc(testId)}')`);

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

    if (name) selectors.push(`getByRole('${esc(role)}', { name: '${esc(name)}' })`);
    else if (isLandmark) selectors.push(`getByRole('${esc(role)}')`);
    if (htmlAttrs?.ariaLabel) {
        selectors.push(`getByLabel('${esc(htmlAttrs.ariaLabel)}')`);
    }
    if (htmlAttrs?.placeholder) {
        selectors.push(`getByPlaceholder('${esc(htmlAttrs.placeholder)}')`);
    }

    if (name && !isLandmark) selectors.push(`getByText('${esc(name)}')`);

    return selectors;
}
