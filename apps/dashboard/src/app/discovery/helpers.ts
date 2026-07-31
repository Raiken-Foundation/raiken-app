export function parseOptionalPositiveInt(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatDate(value: string | null | undefined): string {
    if (!value) return "n/a";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
}

export function safeHttpUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

export function shortenUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname === "/" ? u.host : u.pathname;
    } catch {
        return url.length > 50 ? `${url.slice(0, 47)}…` : url;
    }
}

export function parseEvidence(evidenceJson: string | null | undefined): string | null {
    if (!evidenceJson) return null;
    try {
        const data = JSON.parse(evidenceJson);
        return JSON.stringify(data, null, 2);
    } catch {
        return evidenceJson;
    }
}
