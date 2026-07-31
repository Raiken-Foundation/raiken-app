import { HITL_RESUME_BACKOFF_MS } from "../constants";

/** Whether a repairing workflow should receive a resume attempt now. */
export function shouldAttemptHitlResume(
    workflow: { id: string; status: string },
    resumedIds: ReadonlySet<string>,
    retryAfter: ReadonlyMap<string, number>,
    now: number,
): boolean {
    if (workflow.status !== "repairing") return false;
    if (resumedIds.has(workflow.id)) return false;
    const retryAt = retryAfter.get(workflow.id);
    if (retryAt !== undefined && now < retryAt) return false;
    return true;
}

/** Clear resume guard so the next poll/backoff window can retry a transient failure. */
export function markHitlResumeFailure(
    workflowId: string,
    resumedIds: Set<string>,
    retryAfter: Map<string, number>,
    now: number,
    backoffMs: number = HITL_RESUME_BACKOFF_MS,
): void {
    resumedIds.delete(workflowId);
    retryAfter.set(workflowId, now + backoffMs);
}

export function markHitlResumeSuccess(workflowId: string, retryAfter: Map<string, number>): void {
    retryAfter.delete(workflowId);
}
