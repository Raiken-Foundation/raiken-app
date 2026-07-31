/**
 * Secret redaction for error text, in its own leaf module so both
 * `normalize.ts` (message preservation) and `serialize.ts` (client payloads)
 * can use it without an import cycle.
 */

export const SECRET_KEY_PATTERN =
    /^(password|secret|token|api[_-]?key|authorization|credential|private[_-]?key)$/i;

export const SECRET_VALUE_PATTERNS: RegExp[] = [
    /\bsk-[a-zA-Z0-9_-]{8,}\b/g,
    /\bsk-or-v1-[a-zA-Z0-9_-]+\b/g,
    /\bsk-ant-[a-zA-Z0-9_-]+\b/g,
    /\bgsk_[a-zA-Z0-9_-]+\b/g,
    /\bAIza[a-zA-Z0-9_-]{20,}\b/g,
    /\bpplx-[a-zA-Z0-9_-]+\b/g,
    /\bxai-[a-zA-Z0-9_-]+\b/g,
    /\bBearer\s+[a-zA-Z0-9._-]+\b/gi,
    /\bBasic\s+[a-zA-Z0-9+/=]{8,}\b/gi,
];

/** Redact likely secrets from a string before exposing to clients. */
export function redactSecrets(value: string): string {
    let result = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        result = result.replace(pattern, "[REDACTED]");
    }
    return result;
}
