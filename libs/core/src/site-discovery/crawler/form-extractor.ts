import type { Page } from "playwright";
import { readFormControls } from "../../browser/form-controls";

/**
 * Extract the visible form controls on a page as structured, selector-friendly
 * metadata (label/type/name/id/placeholder per field + submit-button labels).
 * Runs entirely in the page context so it works for any framework. Best-effort:
 * returns null on failure or when the page has no meaningful form controls, so
 * a busted page never aborts the crawl. Persisted per page (forms_json) and fed
 * to test generation so specs reference real fields instead of guessing them.
 *
 * Labels come from the shared accessible-name collector
 * (`browser/form-controls.ts`) — the same one the contract verifier uses, so
 * a fact minted here is re-observable there.
 */
export async function extractPageForms(page: Page): Promise<string | null> {
    try {
        const collected = await readFormControls(page);

        const fields = collected.fields.slice(0, 40).map((field) => ({
            label: field.label.slice(0, 100),
            type: field.type,
            required: field.required,
            placeholder: field.placeholder ? field.placeholder.slice(0, 100) : undefined,
            name: field.name || undefined,
            id: field.id || undefined,
            testId: field.testId || undefined,
        }));

        const submits = collected.submits
            .map((text) => text.slice(0, 60))
            .filter((text) => text.length > 0)
            .slice(0, 15);

        if (fields.length === 0 && submits.length === 0) return null;
        return JSON.stringify({ fields, submits });
    } catch {
        return null;
    }
}
