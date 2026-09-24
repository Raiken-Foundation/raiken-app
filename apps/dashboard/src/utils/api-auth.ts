const TOKEN_META_NAME = "raiken-session-token";
const TOKEN_STORAGE_KEY = "raiken:session-token";

function readTokenFromMeta(): string | null {
    return (
        document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)?.getAttribute("content") ?? null
    );
}

function readTokenFromUrl(): string | null {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("raiken_token");
    if (!token) return null;

    try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        url.searchParams.delete("raiken_token");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
        // The current in-memory call can still use this token if storage is unavailable.
    }
    return token;
}

export function getServerSessionToken(): string | null {
    return readTokenFromMeta() || readTokenFromUrl() || sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function serverAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
    const token = getServerSessionToken();
    return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

export async function fetchServerArtifact(path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(`/api/artifact?path=${encodeURIComponent(path)}`, {
        headers: serverAuthHeaders(),
        signal,
    });
    if (!response.ok) {
        throw new Error(`Unable to load artifact (${response.status})`);
    }
    return response.blob();
}
