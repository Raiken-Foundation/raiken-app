/** Keys whose values are never logged, wherever they appear. */
export const SECRET_KEY_PATTERN =
    /token|secret|password|api[-_]?key|authorization|cookie|session[-_]?id|credential|private[-_]?key/i;

export const SECRET_VALUE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]"],
    [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]"],
    [/([?&](?:access_token|api_key|token|key|authorization|secret)=)[^&\s]+/gi, "$1[redacted]"],
    [/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, "[redacted]"],
    [/\bsk-ant-[A-Za-z0-9_-]+\b/g, "[redacted]"],
];

const DEFAULT_MAX_STRING = 4000;

export function truncateString(value: string, max = DEFAULT_MAX_STRING): string {
    return value.length > max ? `${value.slice(0, max)}… [+${value.length - max} chars]` : value;
}

/** Redact likely secrets from a string. */
export function redactString(value: string, max = DEFAULT_MAX_STRING): string {
    let redacted = value;
    for (const [pattern, replacement] of SECRET_VALUE_REPLACEMENTS) {
        redacted = redacted.replace(pattern, replacement);
    }
    return truncateString(redacted, max);
}

/** JSON-safe deep copy with secret redaction and string truncation. */
export function redactValue(value: unknown, maxString = DEFAULT_MAX_STRING, depth = 0): unknown {
    if (depth > 6) return "[max depth]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactString(value, maxString);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        return value.slice(0, 100).map((item) => redactValue(item, maxString, depth + 1));
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            out[key] = SECRET_KEY_PATTERN.test(key)
                ? "[redacted]"
                : redactValue(val, maxString, depth + 1);
        }
        return out;
    }
    return redactString(String(value), maxString);
}
