const SECRET_TOOL_ARGUMENT = /password|passwd|secret|token|credential|api.?key|cookie/i;

/** Redact sensitive tool arguments before logging or UI callbacks. */
export function redactToolArgs(toolName: string, args: unknown): unknown {
    const textEntryTool = toolName === "fillInput" || toolName === "typeText";
    const visit = (value: unknown, key = ""): unknown => {
        if (SECRET_TOOL_ARGUMENT.test(key) || (textEntryTool && /^(value|text)$/i.test(key))) {
            return "[REDACTED]";
        }
        if (Array.isArray(value)) return value.map((entry) => visit(entry));
        if (value && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
                    childKey,
                    visit(childValue, childKey),
                ]),
            );
        }
        return value;
    };
    return visit(args);
}
