export function safeMarkdownHref(href: string | undefined): string | null {
    if (!href) return null;
    try {
        const parsed = new URL(href, "https://raiken.local");
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.origin === "https://raiken.local" ? href : parsed.href;
    } catch {
        return null;
    }
}
