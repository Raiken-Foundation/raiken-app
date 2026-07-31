/**
 * Internal types shared by BrowserSession decomposition modules.
 * Not exported from the core barrel.
 */

import type { Page } from "playwright";

/** Playwright doesn't export a standalone `AriaRole` type. */
export type AriaRole = Parameters<Page["getByRole"]>[0];

/** Raw element descriptor from a single in-page extraction pass. */
export interface RawElement {
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

export type SelectorKind = "data-testid" | "role" | "text" | "css" | "xpath" | "other";
