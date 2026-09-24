/** Progress/tool events embedded in streamed assistant text. */
export interface AgentStreamEventPayload {
    kind?: string;
    label?: string;
    detail?: string | null;
}

export interface ParsedAgentActivity {
    clean: string;
    activity: string[];
}

export interface SplitAgentStreamChunkResult {
    text: string;
    hitl: Record<string, unknown> | null;
    progress: Array<{ label: string; detail: string | null }>;
}

/** Matches inline activity markers emitted by {@link buildAgentEventMarker}. */
export const AGENT_EVENT_MARKER = /<!--EVENT:([A-Za-z0-9+/=]+?)-->/g;

/** Matches human-in-the-loop approval markers emitted by {@link buildHITLMarker}. */
export const AGENT_HITL_MARKER = /<!--HITL:([\s\S]*?)-->/g;

function decodeBase64Utf8(payload: string): string {
    if (typeof globalThis.atob === "function") {
        return globalThis.atob(payload);
    }
    return Buffer.from(payload, "base64").toString("utf-8");
}

/**
 * Decode a captured marker payload. New markers are base64-encoded JSON; older
 * persisted markers are raw JSON.
 */
export function decodeAgentMarkerJson(payload: string): unknown | null {
    let json = payload;
    if (/^[A-Za-z0-9+/=]+$/.test(payload)) {
        try {
            json = decodeBase64Utf8(payload);
        } catch {
            json = payload;
        }
    }
    try {
        return JSON.parse(json) as unknown;
    } catch {
        return null;
    }
}

/**
 * Extract the agent's live activity trail from streamed text and return the
 * message with EVENT markers removed. Deduplicates consecutive identical labels.
 */
export function parseAgentActivity(raw: string): ParsedAgentActivity {
    const activity: string[] = [];
    const marker = new RegExp(AGENT_EVENT_MARKER.source, "g");
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((match = marker.exec(raw)) !== null) {
        const decoded = decodeAgentMarkerJson(match[1]);
        if (!decoded || typeof decoded !== "object") continue;
        const evt = decoded as AgentStreamEventPayload;
        const label = evt.detail ? `${evt.label} ${evt.detail}` : evt.label;
        if (label && activity[activity.length - 1] !== label) activity.push(label);
    }
    const clean = raw.replace(new RegExp(AGENT_EVENT_MARKER.source, "g"), "");
    return { clean, activity };
}

/**
 * Decode a captured `<!--HITL:…-->` payload. Returns null on any parse failure.
 */
export function decodeHitlPayload(payload: string): Record<string, unknown> | null {
    const parsed = decodeAgentMarkerJson(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/**
 * Remove the first HITL marker from `raw`, returning the decoded payload when present.
 */
export function extractHitlMarker(raw: string): {
    clean: string;
    hitl: Record<string, unknown> | null;
} {
    const match = raw.match(/<!--HITL:([\s\S]*?)-->/);
    if (!match) return { clean: raw, hitl: null };
    const hitl = decodeHitlPayload(match[1]);
    const clean = raw.replace(/<!--HITL:[\s\S]*?-->/, "");
    return { clean, hitl };
}

/**
 * Pull HITL and EVENT markers out of a streamed chunk. Partial markers without
 * a closing `-->` are left in `text` until a later chunk completes them.
 */
export function splitAgentStreamChunk(chunk: string): SplitAgentStreamChunkResult {
    let hitl: Record<string, unknown> | null = null;
    const progress: Array<{ label: string; detail: string | null }> = [];

    let text = chunk.replace(/<!--HITL:([\s\S]*?)-->/g, (_m, payload) => {
        const parsed = decodeHitlPayload(payload as string);
        if (parsed) hitl = parsed;
        return "";
    });

    text = text.replace(/<!--EVENT:([A-Za-z0-9+/=]+?)-->/g, (_m, b64) => {
        const decoded = decodeAgentMarkerJson(b64 as string);
        if (!decoded || typeof decoded !== "object") return "";
        const evt = decoded as AgentStreamEventPayload;
        if (evt.kind === "progress" && evt.label) {
            progress.push({ label: evt.label, detail: evt.detail ?? null });
        }
        return "";
    });

    return { text, hitl, progress };
}
