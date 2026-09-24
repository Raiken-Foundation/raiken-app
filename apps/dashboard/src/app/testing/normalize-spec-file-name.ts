// Coerce an arbitrary tab name into a valid Playwright spec filename that the
// server's strict validator (`^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$`)
// will accept. Used for auto-save-on-run and rename so the user never has to
// hand-craft a compliant name.
export function normalizeSpecFileName(rawName: string, content?: string): string {
    let base = (rawName || "").trim().replace(/^scratch:/, "");
    // Already a valid spec name → keep it.
    if (/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/.test(base)) return base;

    // Strip any extension, then sanitize the stem.
    let stem = base
        .replace(/\.(spec|test)\.(ts|tsx|js|jsx)$/i, "")
        .replace(/\.(ts|tsx|js|jsx)$/i, "");
    stem = stem
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    // Fall back to the test.describe title, then a generic name.
    if (!stem && content) {
        const m = content.match(/test\.describe\(\s*['"`](.+?)['"`]/);
        if (m)
            stem = m[1]
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
    }
    if (!stem) stem = "generated-test";
    base = `${stem}.spec.ts`;
    return base;
}
