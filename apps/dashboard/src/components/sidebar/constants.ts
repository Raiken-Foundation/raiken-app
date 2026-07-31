import type { Message } from "./types";

export const CONVERSATION_WINDOW = 30;

export const WELCOME_MESSAGE: Message = {
    id: "welcome",
    content:
        "`raiken/agent` is ready.\n\nDescribe a test in plain english and I will draft it. Use `@` to attach files, or `/` to run a command.\n\nExamples:\n- `Generate a test for the LoginForm component`\n- `Write tests for the @src/utils.ts file`\n- `/discovery https://example.com` — crawl a site\n- `/doctor` — scan test suite for anti-patterns\n- `/help` — list every slash command",
    timestamp: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    isUser: false,
};

/** Poll interval for cross-surface chat sync (REPL → dashboard). */
export const CHAT_SYNC_POLL_MS = 3000;

/** Poll interval for durable HITL workflow reconciliation. */
export const HITL_SYNC_POLL_MS = 3000;

/** Slower workflow poll while the agent stream is in-flight. */
export const HITL_SYNC_POLL_SLOW_MS = 8000;

/** Backoff before retrying a failed repair-workflow resume. */
export const HITL_RESUME_BACKOFF_MS = 5000;

export const NEAR_BOTTOM_THRESHOLD = 80;

export const COMPOSER_MAX_HEIGHT_PX = 160;

/** Core poll-interval logic (testable without Vitest env guards). */
export function resolveVisiblePollIntervalInner(
    baseMs: number,
    slowMs: number,
    isGenerating: boolean,
    pausePolling = false,
    documentHidden = typeof document !== "undefined" ? document.hidden : false,
): number | false {
    if (pausePolling) return false;
    if (documentHidden) return false;
    return isGenerating ? slowMs : baseMs;
}

/** Returns false when the dashboard tab is hidden or polling should pause. */
export function resolveVisiblePollInterval(
    baseMs: number,
    slowMs: number,
    isGenerating: boolean,
    pausePolling = false,
): number | false {
    if (import.meta.env.MODE === "test") return false;
    return resolveVisiblePollIntervalInner(baseMs, slowMs, isGenerating, pausePolling);
}
