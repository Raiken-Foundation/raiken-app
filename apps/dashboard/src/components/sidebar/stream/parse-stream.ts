import { extractHitlMarker, parseAgentActivity } from "@raiken/shared";
import type { HITLConfirmation } from "../types";

export function parseStreamedAssistantContent(raw: string): {
    clean: string;
    activity: string[];
    hitl: HITLConfirmation | null;
} {
    const { clean: withoutEvents, activity } = parseAgentActivity(raw);
    const { clean, hitl } = extractHitlMarker(withoutEvents);
    return {
        clean,
        activity,
        hitl: hitl as unknown as HITLConfirmation | null,
    };
}

export function formatInterruptedAssistantMessage(
    accumulated: string,
    errorMessage: string,
    stopped: boolean,
): string {
    const partial = parseStreamedAssistantContent(accumulated).clean;
    if (stopped) return partial ? `${partial}\n\n_Stopped._` : "_Stopped._";
    return partial ? `${partial}\n\n_Error: ${errorMessage}_` : `Error: ${errorMessage}`;
}
