import type { HitlWorkflowRecord } from "@raiken/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../../utils/trpc";
import {
    HITL_SYNC_POLL_MS,
    HITL_SYNC_POLL_SLOW_MS,
    resolveVisiblePollInterval,
} from "../constants";
import {
    markHitlResumeFailure,
    markHitlResumeSuccess,
    shouldAttemptHitlResume,
} from "./resume-state";

const EMPTY_WORKFLOWS: HitlWorkflowRecord[] = [];

function repairingWorkflowKey(workflows: Array<{ id: string; status: string }>): string {
    return workflows
        .filter((workflow) => workflow.status === "repairing")
        .map((workflow) => workflow.id)
        .sort()
        .join(",");
}

/** Resume interrupted repair workflows once per workflow id, with retry on failure. */
export function useHitlWorkflowResume(activeWorkflows: Array<{ id: string; status: string }>) {
    const trpcUtils = trpc.useUtils();
    const advanceHitlMutation = trpc.advanceHitlWorkflow.useMutation();
    const resumedWorkflowIdsRef = useRef(new Set<string>());
    const retryAfterRef = useRef(new Map<string, number>());
    const workflowsRef = useRef(activeWorkflows);
    const mountedRef = useRef(true);
    const retryTimerRef = useRef<number | null>(null);
    const [isResuming, setIsResuming] = useState(false);
    const inFlightRef = useRef(0);

    const advanceAsyncRef = useRef(advanceHitlMutation.mutateAsync);
    advanceAsyncRef.current = advanceHitlMutation.mutateAsync;
    const invalidateRef = useRef(trpcUtils.listActiveHitlWorkflows.invalidate);
    invalidateRef.current = trpcUtils.listActiveHitlWorkflows.invalidate;

    workflowsRef.current = activeWorkflows;
    const repairingKey = useMemo(() => repairingWorkflowKey(activeWorkflows), [activeWorkflows]);

    useEffect(() => {
        mountedRef.current = true;

        const clearRetryTimer = () => {
            if (retryTimerRef.current !== null) {
                window.clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
        };

        const scheduleRetry = () => {
            clearRetryTimer();
            const retryAt = [...retryAfterRef.current.values()].sort((a, b) => a - b)[0];
            if (retryAt === undefined || retryAt <= Date.now()) return;
            retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                tick();
            }, retryAt - Date.now());
        };

        const tick = () => {
            if (!mountedRef.current) return;
            const now = Date.now();
            for (const workflow of workflowsRef.current) {
                if (
                    !shouldAttemptHitlResume(
                        workflow,
                        resumedWorkflowIdsRef.current,
                        retryAfterRef.current,
                        now,
                    )
                ) {
                    continue;
                }
                resumedWorkflowIdsRef.current.add(workflow.id);
                inFlightRef.current += 1;
                setIsResuming(true);

                void advanceAsyncRef
                    .current({ workflowId: workflow.id })
                    .then(() => {
                        if (!mountedRef.current) return;
                        markHitlResumeSuccess(workflow.id, retryAfterRef.current);
                    })
                    .catch(() => {
                        if (!mountedRef.current) return;
                        markHitlResumeFailure(
                            workflow.id,
                            resumedWorkflowIdsRef.current,
                            retryAfterRef.current,
                            Date.now(),
                        );
                        scheduleRetry();
                    })
                    .finally(() => {
                        if (!mountedRef.current) return;
                        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
                        setIsResuming(inFlightRef.current > 0);
                        void invalidateRef.current();
                    });
            }
        };

        tick();

        return () => {
            mountedRef.current = false;
            clearRetryTimer();
            inFlightRef.current = 0;
        };
    }, [repairingKey]);

    return { isResuming };
}

export interface ActiveHitlWorkflowsState {
    workflows: HitlWorkflowRecord[];
    /** True after at least one successful listActiveHitlWorkflows response. */
    workflowsAuthoritative: boolean;
    isWorkflowQueryError: boolean;
    isWorkflowQueryLoading: boolean;
}

export function useActiveHitlWorkflows(
    isGenerating: boolean,
    pausePolling = false,
): ActiveHitlWorkflowsState {
    const authoritativeRef = useRef<HitlWorkflowRecord[] | null>(null);
    const [workflowsAuthoritative, setWorkflowsAuthoritative] = useState(false);

    const query = trpc.listActiveHitlWorkflows.useQuery(undefined, {
        refetchOnWindowFocus: true,
        refetchInterval: () =>
            resolveVisiblePollInterval(
                HITL_SYNC_POLL_MS,
                HITL_SYNC_POLL_SLOW_MS,
                isGenerating,
                pausePolling,
            ),
    });

    useEffect(() => {
        if (query.isSuccess) {
            authoritativeRef.current = query.data ?? EMPTY_WORKFLOWS;
            setWorkflowsAuthoritative(true);
        }
    }, [query.isSuccess, query.data]);

    const workflows = useMemo(
        () =>
            query.isError
                ? (authoritativeRef.current ?? EMPTY_WORKFLOWS)
                : (query.data ?? authoritativeRef.current ?? EMPTY_WORKFLOWS),
        [query.isError, query.data],
    );

    return {
        workflows,
        workflowsAuthoritative,
        isWorkflowQueryError: query.isError,
        isWorkflowQueryLoading: query.isLoading && !workflowsAuthoritative,
    };
}
