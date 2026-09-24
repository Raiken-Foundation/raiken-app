const GENERIC_MESSAGES = new Set([
    "received one or more errors",
    "aggregateerror",
    "multiple errors",
]);

function conciseMessage(value: string): string {
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("at "));
    return lines.slice(0, 4).join(" ").slice(0, 600);
}

function collectMessages(error: unknown, seen: Set<unknown>, depth = 0): string[] {
    if (error === null || error === undefined || depth > 5 || seen.has(error)) return [];
    if (typeof error === "object") seen.add(error);

    if (error instanceof AggregateError) {
        const own = GENERIC_MESSAGES.has(error.message.trim().toLowerCase())
            ? []
            : [conciseMessage(error.message)];
        return [
            ...own,
            ...Array.from(error.errors).flatMap((child) => collectMessages(child, seen, depth + 1)),
        ];
    }

    if (error instanceof Error) {
        const message = conciseMessage(error.message);
        const cause = (error as Error & { cause?: unknown }).cause;
        return [
            ...(message && !GENERIC_MESSAGES.has(message.toLowerCase()) ? [message] : []),
            ...collectMessages(cause, seen, depth + 1),
        ];
    }

    if (typeof error === "object") {
        const record = error as { message?: unknown; errors?: unknown };
        const own =
            typeof record.message === "string" &&
            !GENERIC_MESSAGES.has(record.message.trim().toLowerCase())
                ? [conciseMessage(record.message)]
                : [];
        const nested = Array.isArray(record.errors)
            ? record.errors.flatMap((child) => collectMessages(child, seen, depth + 1))
            : [];
        return [...own, ...nested];
    }

    return [conciseMessage(String(error))];
}

/**
 * Expand AggregateError/cause chains into a concise terminal-safe diagnostic.
 * Crawlee otherwise exposes only "Received one or more errors", hiding the
 * request, database, or browser exception that actually stopped discovery.
 */
export function formatDiscoveryError(error: unknown): string {
    const messages = collectMessages(error, new Set()).filter(Boolean);
    const counts = new Map<string, number>();
    for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
    const unique = Array.from(counts, ([message, count]) =>
        count > 1 ? `${message} (repeated ${count} times)` : message,
    );

    if (unique.length === 0) {
        return "Discovery failed, but the crawler did not expose an underlying error.";
    }
    if (unique.length === 1) return unique[0];
    return `Multiple discovery errors:\n${unique
        .map((message, index) => `  ${index + 1}. ${message}`)
        .join("\n")}`;
}
