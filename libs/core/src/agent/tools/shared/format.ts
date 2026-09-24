import type { DOMContext } from "../../../browser/dom-capture";
import { formatDOMContext } from "../../../browser/dom-capture";
import type { BrowserSession } from "../../../browser/session";
import type { ActionResultData, PageSnapshot, ToolResult } from "../types";

export function buildPageSnapshot(domContext: DOMContext): PageSnapshot {
    const summary = formatDOMContext(domContext);
    return {
        url: domContext.url,
        title: domContext.title,
        elements: domContext.interactiveElements.length,
        forms: domContext.formFields.length,
        summary,
    };
}

/**
 * Re-capture the page after an interaction so the agent always sees the new
 * state (URL + DOM) instead of reasoning against a stale snapshot. `changed`
 * reflects whether the URL changed relative to before the action.
 */
export async function snapshotAfterAction(
    session: BrowserSession,
    prevUrl?: string,
): Promise<
    ActionResultData & { url: string; summary: string; changed: boolean; captured: boolean }
> {
    try {
        await session.settle();
        const dom = await session.captureCurrentPage();
        const snap = buildPageSnapshot(dom);
        return {
            url: snap.url,
            summary: snap.summary,
            changed: prevUrl !== undefined ? snap.url !== prevUrl : true,
            captured: true,
        };
    } catch {
        return {
            url: prevUrl ?? "",
            summary: "(page state could not be re-captured after this action)",
            changed: false,
            captured: false,
        };
    }
}

export function formatToolError<T = unknown>(context: string, error: unknown): ToolResult<T> {
    return {
        success: false,
        message: `${context}: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
}
