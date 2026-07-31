/**
 * Reduce a Playwright/Crawlee navigation error to a one-line, user-
 * friendly reason. We swallow the stack and pull out the recognisable
 * Chrome NET error code (e.g. `NET::ERR_HTTP_RESPONSE_CODE_FAILURE`)
 * because the raw message is multi-paragraph and noisy.
 */
export function summariseNavigationFailure(
    error: Error | undefined,
    status: number | null,
): string {
    if (status && status >= 400) {
        return `HTTP ${status}`;
    }
    const raw = error?.message ?? "Unknown navigation failure";
    const netCode = raw.match(/net::ERR_[A-Z_0-9]+/i)?.[0];
    if (netCode) return netCode;
    if (/Timeout .* exceeded/i.test(raw)) return "Navigation timeout";
    if (/Target .* closed|Browser .* closed/i.test(raw)) return "Browser closed mid-navigation";
    if (/Maximum retry count exceeded/i.test(raw)) return "Retry exhausted";
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw;
    return firstLine.slice(0, 200);
}
