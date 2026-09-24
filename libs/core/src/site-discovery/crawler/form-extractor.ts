import type { Page } from "playwright";

/**
 * Extract the visible form controls on a page as structured, selector-friendly
 * metadata (label/type/name/id/placeholder per field + submit-button labels).
 * Runs entirely in the page context so it works for any framework. Best-effort:
 * returns null on failure or when the page has no meaningful form controls, so
 * a busted page never aborts the crawl. Persisted per page (forms_json) and fed
 * to test generation so specs reference real fields instead of guessing them.
 */
export async function extractPageForms(page: Page): Promise<string | null> {
    try {
        const forms = await page.evaluate(() => {
            const isVisible = (el: Element): boolean => {
                const he = el as HTMLElement;
                if (he.hidden) return false;
                const style = window.getComputedStyle(he);
                if (style.display === "none" || style.visibility === "hidden") return false;
                return he.offsetParent !== null || style.position === "fixed";
            };

            const labelFor = (el: Element): string => {
                const aria = el.getAttribute("aria-label");
                if (aria?.trim()) return aria.trim();
                const labelledby = el.getAttribute("aria-labelledby");
                if (labelledby) {
                    const text = labelledby
                        .split(/\s+/)
                        .map((id) => document.getElementById(id)?.textContent || "")
                        .join(" ")
                        .trim();
                    if (text) return text;
                }
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

            const fieldEls = Array.from(
                document.querySelectorAll("input, select, textarea"),
            ).filter((el) => {
                const type = (el.getAttribute("type") || "").toLowerCase();
                if (type === "hidden") return false;
                return isVisible(el);
            });

            const fields = fieldEls.slice(0, 40).map((el) => {
                const tag = el.tagName.toLowerCase();
                const placeholder = el.getAttribute("placeholder");
                const name = el.getAttribute("name");
                const idAttr = (el as HTMLInputElement).id;
                const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
                return {
                    label: labelFor(el).slice(0, 100),
                    type: (el.getAttribute("type") || tag).toLowerCase(),
                    required:
                        el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
                    placeholder: placeholder ? placeholder.slice(0, 100) : undefined,
                    name: name || undefined,
                    id: idAttr || undefined,
                    testId: testId || undefined,
                };
            });

            const submits = Array.from(
                document.querySelectorAll(
                    "button, input[type=submit], input[type=button], [role=button]",
                ),
            )
                .filter((el) => isVisible(el))
                .map((el) =>
                    (
                        el.textContent ||
                        el.getAttribute("value") ||
                        el.getAttribute("aria-label") ||
                        ""
                    )
                        .trim()
                        .slice(0, 60),
                )
                .filter((text) => text.length > 0)
                .slice(0, 15);

            return { fields, submits };
        });

        if (forms.fields.length === 0 && forms.submits.length === 0) return null;
        return JSON.stringify(forms);
    } catch {
        return null;
    }
}
