import { useCallback } from "react";
import { trpc } from "../../utils/trpc";
import { parseOptionalPositiveInt } from "./helpers";
import { isDiscoveryActionPending, isDiscoveryRunning, isHandoffActive } from "./runtime-state";
import type { BlockerCategory, BlockerResolution, DiscoveryFormState } from "./types";

interface UseDiscoveryActionsParams {
    form: DiscoveryFormState;
    phase: string | undefined;
    runtimeHandoffInProgress: boolean;
    onClearSelections: () => void;
    onDismissCompletionReset: () => void;
    setPendingBlockerId: (id: number | null) => void;
    setPendingHandoffId: (id: number | null) => void;
}

export function useDiscoveryActions({
    form,
    phase,
    runtimeHandoffInProgress,
    onClearSelections,
    onDismissCompletionReset,
    setPendingBlockerId,
    setPendingHandoffId,
}: UseDiscoveryActionsParams) {
    const utils = trpc.useUtils();

    const refreshAll = useCallback(async () => {
        await Promise.all([
            utils.getDiscoveryRuntime.invalidate(),
            utils.getDiscoveryStats.invalidate(),
            utils.getDiscoverySession.invalidate(),
            utils.getDiscoveredPages.invalidate(),
            utils.getDiscoveredPageSnapshot.invalidate(),
            utils.getAuthBlockers.invalidate(),
            utils.getDiscoveryTimeline.invalidate(),
            utils.getVerifiedLinks.invalidate(),
        ]);
    }, [utils]);

    const startMutation = trpc.startDiscovery.useMutation({
        onSuccess: () => {
            onDismissCompletionReset();
            void refreshAll();
        },
    });
    const continueMutation = trpc.continueDiscovery.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const clearMutation = trpc.clearDiscoveryData.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const pauseMutation = trpc.pauseDiscovery.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const handoffMutation = trpc.requestBrowserHandoff.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const cancelHandoffMutation = trpc.cancelBrowserHandoff.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const abortMutation = trpc.abortDiscovery.useMutation({
        onSuccess: () => void refreshAll(),
    });
    const dismissErrorMutation = trpc.dismissDiscoveryError.useMutation({
        onSuccess: () => void refreshAll(),
    });

    const mutationPending = {
        start: startMutation.isPending,
        continue: continueMutation.isPending,
        clear: clearMutation.isPending,
        pause: pauseMutation.isPending,
        abort: abortMutation.isPending,
        dismissError: dismissErrorMutation.isPending,
        cancelHandoff: cancelHandoffMutation.isPending,
        handoff: handoffMutation.isPending,
    };
    const actionPending = isDiscoveryActionPending(mutationPending, runtimeHandoffInProgress);
    const handoffActive = isHandoffActive(mutationPending.handoff, {
        isBrowserHandoffInProgress: runtimeHandoffInProgress,
    });
    const running = isDiscoveryRunning(phase);

    const handleStart = () => {
        onDismissCompletionReset();
        startMutation.mutate({
            url: form.url.trim(),
            maxPages: parseOptionalPositiveInt(form.maxPages),
            maxDepth: parseOptionalPositiveInt(form.maxDepth),
            timeout: parseOptionalPositiveInt(form.timeout),
            skipAuth: form.skipAuth,
            excludePatterns: form.excludePatterns.length > 0 ? form.excludePatterns : undefined,
        });
    };

    const handleContinue = () => {
        continueMutation.mutate({ skipAuth: form.skipAuth });
    };

    const resolveBlocker = (
        blockerId: number,
        category: BlockerCategory,
        resolution: BlockerResolution,
    ) => {
        if (actionPending) return;
        setPendingBlockerId(blockerId);
        continueMutation.mutate(
            { blockerId, category, resolution, skipAuth: form.skipAuth },
            { onSettled: () => setPendingBlockerId(null) },
        );
    };

    const openHandoff = (blockerId: number, category: BlockerCategory) => {
        if (actionPending) return;
        setPendingHandoffId(blockerId);
        handoffMutation.mutate(
            { blockerId, category },
            {
                onSettled: () => setPendingHandoffId(null),
                onSuccess: (result) => {
                    if (!result?.success) return;
                    const storageStatePath =
                        "storageStatePath" in result && typeof result.storageStatePath === "string"
                            ? result.storageStatePath
                            : undefined;
                    if (category === "auth_required" || storageStatePath) {
                        continueMutation.mutate({
                            blockerId,
                            category,
                            resolution: "provide_state",
                            storageStatePath,
                            skipAuth: form.skipAuth,
                        });
                    }
                },
            },
        );
    };

    const cancelHandoff = () => {
        if (!handoffActive || cancelHandoffMutation.isPending) return;
        cancelHandoffMutation.mutate({});
    };

    const handlePause = () => {
        if (!running || actionPending) return;
        pauseMutation.mutate({});
    };

    const handleClear = () => {
        if (actionPending) return;
        onClearSelections();
        clearMutation.mutate({});
    };

    const handleAbort = () => {
        if (!running || abortMutation.isPending) return;
        abortMutation.mutate({});
    };

    const handleDismissError = () => {
        if (dismissErrorMutation.isPending) return;
        dismissErrorMutation.mutate({});
    };

    return {
        mutationPending,
        actionPending,
        handoffActive,
        startMutation,
        continueMutation,
        clearMutation,
        pauseMutation,
        handoffMutation,
        cancelHandoffMutation,
        abortMutation,
        dismissErrorMutation,
        handleStart,
        handleContinue,
        resolveBlocker,
        openHandoff,
        cancelHandoff,
        handlePause,
        handleClear,
        handleAbort,
        handleDismissError,
    };
}
