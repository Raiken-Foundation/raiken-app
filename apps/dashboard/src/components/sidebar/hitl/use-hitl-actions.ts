import { type HitlWorkflowRecord, splitTestSavePath } from "@raiken/shared";
import { useCallback, useRef, useState } from "react";
import { shouldAvoidOverwrite } from "../../../utils/save-target";
import { trpc } from "../../../utils/trpc";
import { buildConversationWindow } from "../chat/conversation";
import { parseStreamedAssistantContent } from "../stream/parse-stream";
import {
    type AgentStreamCallbacks,
    type AgentStreamRequest,
    applyStreamError,
} from "../stream/use-agent-stream";
import type {
    HITLConfirmation,
    Message,
    RunApprovalResolution,
    SaveApprovalResolution,
} from "../types";

interface UseHitlActionsOptions {
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    persistMessage: (message: Message) => void;
    onFileSelect?: (filePath: string) => void;
    refetchTestFiles: () => void;
    setIsGenerating: (value: boolean) => void;
    runStream: (
        request: AgentStreamRequest,
        aiMessageId: string,
        setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
        callbacks?: AgentStreamCallbacks,
    ) => Promise<void>;
    messages: Message[];
}

export function useHitlActions({
    setMessages,
    persistMessage,
    onFileSelect,
    refetchTestFiles,
    setIsGenerating,
    runStream,
    messages,
}: UseHitlActionsOptions) {
    const trpcUtils = trpc.useUtils();
    const saveTestMutation = trpc.saveGeneratedTest.useMutation();
    const updateConfigMutation = trpc.updateConfig.useMutation({
        onSuccess: async (result) => {
            if (result.success) await trpcUtils.getConfig.invalidate();
        },
    });
    const runTestMutation = trpc.runTests.useMutation();
    const continueHitlMutation = trpc.continueHitlWorkflow.useMutation();
    const saveInFlightRef = useRef(new Set<string>());

    const [sessionSaveApprovals, setSessionSaveApprovals] = useState<
        Record<string, SaveApprovalResolution>
    >({});
    const [sessionRunApprovals, setSessionRunApprovals] = useState<
        Record<string, RunApprovalResolution>
    >({});
    const [pathEdits, setPathEdits] = useState<Record<string, string>>({});
    const [runningTestFor, setRunningTestFor] = useState<string | null>(null);

    const clearSessionApprovals = useCallback(() => {
        setSessionSaveApprovals({});
        setSessionRunApprovals({});
        setPathEdits({});
    }, []);

    const handleHITLAction = useCallback(
        async (actionId: string, context: { url?: string; files?: string[] }) => {
            const actionLabel =
                actionId === "proceed" ? "✅ Proceed with test generation" : "❌ Cancel";
            const userMessage: Message = {
                id: Date.now().toString(),
                content: actionLabel,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: true,
            };
            setMessages((prev) => [...prev, userMessage]);
            setIsGenerating(true);

            const aiMessageId = (Date.now() + 1).toString();
            const aiMessage: Message = {
                id: aiMessageId,
                content: "",
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
                isLoading: true,
            };
            setMessages((prev) => [...prev, aiMessage]);

            await runStream(
                {
                    prompt: `HITL_ACTION:${actionId}:${JSON.stringify(context)}`,
                    fileContext: context.files ?? [],
                    conversationHistory: buildConversationWindow(messages),
                },
                aiMessageId,
                setMessages,
                {
                    onComplete: (accumulated) => {
                        const cleanedFinal = parseStreamedAssistantContent(accumulated).clean;
                        persistMessage({
                            id: aiMessageId,
                            content: cleanedFinal,
                            timestamp: new Date().toLocaleTimeString("en-US", {
                                hour: "2-digit",
                                minute: "2-digit",
                            }),
                            isUser: false,
                        });
                    },
                    onError: (accumulated, id, error) => {
                        const interruptedContent = applyStreamError(
                            accumulated,
                            id,
                            error,
                            setMessages,
                        );
                        persistMessage({
                            id,
                            content: interruptedContent,
                            timestamp: new Date().toLocaleTimeString("en-US", {
                                hour: "2-digit",
                                minute: "2-digit",
                            }),
                            isUser: false,
                        });
                    },
                },
            );
        },
        [messages, persistMessage, runStream, setIsGenerating, setMessages],
    );

    const handleSaveApproval = useCallback(
        async (
            messageId: string,
            actionId: "save_approve" | "save_approve_remember" | "save_reject",
            hitl: HITLConfirmation,
            activeWorkflows: HitlWorkflowRecord[],
        ) => {
            if (sessionSaveApprovals[messageId] || saveInFlightRef.current.has(messageId)) return;
            const workflowId = hitl.context.workflowId;
            if (workflowId) {
                const pending = activeWorkflows.some(
                    (workflow) =>
                        workflow.id === workflowId && workflow.status === "await_save_approval",
                );
                if (!pending) return;
            }

            saveInFlightRef.current.add(messageId);
            try {
                if (workflowId) {
                    const result = await continueHitlMutation.mutateAsync({
                        workflowId,
                        action: "save",
                        decision: actionId === "save_reject" ? "reject" : "approve",
                        filePath:
                            actionId === "save_reject"
                                ? undefined
                                : (pathEdits[messageId] ?? hitl.suggestedPath ?? "").trim() ||
                                  undefined,
                    });
                    await trpcUtils.listActiveHitlWorkflows.invalidate();
                    if (actionId === "save_approve_remember") {
                        await updateConfigMutation.mutateAsync({
                            config: { autonomy: { autoSaveTests: true } },
                        });
                    }
                    const rejected = result.workflow.status === "cancelled";
                    setSessionSaveApprovals((prev) => ({
                        ...prev,
                        [messageId]: rejected
                            ? { status: "rejected" }
                            : { status: "saved", filePath: result.savedPath },
                    }));
                    if (result.savedPath) {
                        void refetchTestFiles();
                        onFileSelect?.(result.savedPath);
                    }
                    return;
                }

                if (actionId === "save_reject") {
                    setSessionSaveApprovals((prev) => ({
                        ...prev,
                        [messageId]: { status: "rejected" },
                    }));
                    const rejectMessage: Message = {
                        id: `sys-${Date.now()}`,
                        content: "❌ Rejected. The draft was discarded.",
                        timestamp: new Date().toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                        isUser: false,
                    };
                    setMessages((prev) => [...prev, rejectMessage]);
                    persistMessage(rejectMessage);
                    return;
                }

                const requestedPath = (pathEdits[messageId] ?? hitl.suggestedPath ?? "").trim();
                const testCode = hitl.testCode ?? "";
                if (!requestedPath || !testCode) {
                    setSessionSaveApprovals((prev) => ({
                        ...prev,
                        [messageId]: {
                            status: "rejected",
                            error: "Missing path or test content — cannot save.",
                        },
                    }));
                    return;
                }

                const { fileName, testDir } = splitTestSavePath(requestedPath, "e2e");

                const result = await saveTestMutation.mutateAsync({
                    fileName,
                    content: testCode,
                    testDir,
                    avoidOverwrite: shouldAvoidOverwrite({
                        suggestedPath: hitl.suggestedPath,
                        requestedPath,
                        overwriteTarget: hitl.overwriteTarget,
                    }),
                });

                if (actionId === "save_approve_remember") {
                    try {
                        await updateConfigMutation.mutateAsync({
                            config: { autonomy: { autoSaveTests: true } },
                        });
                    } catch (err) {
                        console.warn("Failed to persist autoSaveTests preference:", err);
                    }
                }

                setSessionSaveApprovals((prev) => ({
                    ...prev,
                    [messageId]: { status: "saved", filePath: result.filePath },
                }));

                const confirmMsg: Message = {
                    id: `sys-${Date.now()}`,
                    content:
                        actionId === "save_approve_remember"
                            ? `✅ Saved \`${result.filePath}\`. Future tests will save automatically.`
                            : `✅ Saved \`${result.filePath}\`.`,
                    timestamp: new Date().toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    isUser: false,
                };
                setMessages((prev) => [...prev, confirmMsg]);
                persistMessage(confirmMsg);
                refetchTestFiles();
                if (result.filePath) onFileSelect?.(result.filePath);
            } catch (error) {
                if (workflowId) {
                    setSessionSaveApprovals((prev) => ({
                        ...prev,
                        [messageId]: {
                            status: "rejected",
                            error: error instanceof Error ? error.message : "Save failed",
                        },
                    }));
                    return;
                }
                const errorMessage = error instanceof Error ? error.message : "Save failed";
                setSessionSaveApprovals((prev) => ({
                    ...prev,
                    [messageId]: { status: "rejected", error: errorMessage },
                }));
                const errMsg: Message = {
                    id: `sys-${Date.now()}`,
                    content: `⚠️ Could not save: ${errorMessage}`,
                    timestamp: new Date().toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    isUser: false,
                };
                setMessages((prev) => [...prev, errMsg]);
            } finally {
                saveInFlightRef.current.delete(messageId);
            }
        },
        [
            continueHitlMutation,
            onFileSelect,
            pathEdits,
            persistMessage,
            refetchTestFiles,
            saveTestMutation,
            sessionSaveApprovals,
            setMessages,
            trpcUtils.listActiveHitlWorkflows,
            updateConfigMutation,
        ],
    );

    const handleRunApproval = useCallback(
        async (
            messageId: string,
            actionId: "run_approve" | "run_approve_remember" | "run_reject",
            hitl: HITLConfirmation,
            activeWorkflows: HitlWorkflowRecord[],
        ) => {
            if (sessionRunApprovals[messageId] || runningTestFor) return;
            const workflowId = hitl.context.workflowId;
            if (workflowId) {
                const pending = activeWorkflows.some(
                    (workflow) =>
                        workflow.id === workflowId && workflow.status === "await_run_approval",
                );
                if (!pending) return;
            }

            if (workflowId) {
                if (actionId === "run_approve_remember") {
                    await updateConfigMutation.mutateAsync({
                        config: { autonomy: { autoRunTests: true } },
                    });
                }
                setRunningTestFor(messageId);
                try {
                    const result = await continueHitlMutation.mutateAsync({
                        workflowId,
                        action: "run",
                        decision: actionId === "run_reject" ? "reject" : "approve",
                    });
                    await trpcUtils.listActiveHitlWorkflows.invalidate();
                    const passed = result.run?.success;
                    setSessionRunApprovals((prev) => ({
                        ...prev,
                        [messageId]:
                            result.workflow.status === "cancelled"
                                ? { status: "skipped" }
                                : { status: "ran", passed },
                    }));
                    if (passed === false && hitl.testFile) onFileSelect?.(hitl.testFile);
                    return;
                } catch (error) {
                    setSessionRunApprovals((prev) => ({
                        ...prev,
                        [messageId]: {
                            status: "ran",
                            error: error instanceof Error ? error.message : "Test run failed",
                        },
                    }));
                    return;
                } finally {
                    setRunningTestFor(null);
                }
            }

            if (actionId === "run_reject") {
                setSessionRunApprovals((prev) => ({ ...prev, [messageId]: { status: "skipped" } }));
                return;
            }

            const testFile = hitl.testFile ?? "";
            if (!testFile) {
                setSessionRunApprovals((prev) => ({
                    ...prev,
                    [messageId]: { status: "skipped", error: "Missing test file — cannot run." },
                }));
                return;
            }

            if (actionId === "run_approve_remember") {
                try {
                    await updateConfigMutation.mutateAsync({
                        config: { autonomy: { autoRunTests: true } },
                    });
                } catch (err) {
                    console.warn("Failed to persist autoRunTests preference:", err);
                }
            }

            setRunningTestFor(messageId);
            try {
                const result = await runTestMutation.mutateAsync({ testFile });
                if (result.cancelled) {
                    setSessionRunApprovals((prev) => ({
                        ...prev,
                        [messageId]: { status: "cancelled" },
                    }));
                    const cancelledMessage: Message = {
                        id: `sys-run-${Date.now()}`,
                        content: `⏹️ \`${testFile}\` run cancelled.`,
                        timestamp: new Date().toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                        isUser: false,
                    };
                    setMessages((prev) => [...prev, cancelledMessage]);
                    persistMessage(cancelledMessage);
                    return;
                }
                const passed = Boolean(result.success);
                setSessionRunApprovals((prev) => ({
                    ...prev,
                    [messageId]: { status: "ran", passed },
                }));
                const resultMsg: Message = {
                    id: `sys-run-${Date.now()}`,
                    content: passed
                        ? `✅ \`${testFile}\` passed.`
                        : `❌ \`${testFile}\` failed. Open it in the editor and use **Fix with AI** to repair the spec.`,
                    timestamp: new Date().toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    isUser: false,
                };
                setMessages((prev) => [...prev, resultMsg]);
                persistMessage(resultMsg);
                if (!passed) onFileSelect?.(testFile);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Test run failed";
                setSessionRunApprovals((prev) => ({
                    ...prev,
                    [messageId]: { status: "ran", error: errorMessage },
                }));
            } finally {
                setRunningTestFor(null);
            }
        },
        [
            continueHitlMutation,
            onFileSelect,
            persistMessage,
            runTestMutation,
            runningTestFor,
            sessionRunApprovals,
            setMessages,
            trpcUtils.listActiveHitlWorkflows,
            updateConfigMutation,
        ],
    );

    const handleRunSavedTest = useCallback(
        async (messageId: string, filePath: string, workflowId?: string) => {
            if (runningTestFor) return;
            setRunningTestFor(messageId);
            const runningMsg: Message = {
                id: `sys-run-${Date.now()}`,
                content: `▶️ Running \`${filePath}\`…`,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, runningMsg]);

            try {
                let passed: boolean;
                if (workflowId) {
                    const result = await continueHitlMutation.mutateAsync({
                        workflowId,
                        action: "run",
                        decision: "approve",
                    });
                    passed = Boolean(result.run?.success);
                    await trpcUtils.listActiveHitlWorkflows.invalidate();
                } else {
                    const result = await runTestMutation.mutateAsync({ testFile: filePath });
                    passed = Boolean(result.success);
                }
                const summary = passed
                    ? `✅ \`${filePath}\` passed.`
                    : `❌ \`${filePath}\` failed. Open it in the editor and use **Fix with AI** to repair the spec.`;
                const resultMsg: Message = {
                    id: `sys-run-done-${Date.now()}`,
                    content: summary,
                    timestamp: new Date().toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    isUser: false,
                };
                setMessages((prev) => [...prev, resultMsg]);
                persistMessage(resultMsg);
                if (!passed) onFileSelect?.(filePath);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Test run failed";
                const errMsg: Message = {
                    id: `sys-run-err-${Date.now()}`,
                    content: `⚠️ Could not run test: ${errorMessage}`,
                    timestamp: new Date().toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    isUser: false,
                };
                setMessages((prev) => [...prev, errMsg]);
            } finally {
                setRunningTestFor(null);
            }
        },
        [
            continueHitlMutation,
            onFileSelect,
            persistMessage,
            runTestMutation,
            runningTestFor,
            setMessages,
            trpcUtils.listActiveHitlWorkflows,
        ],
    );

    return {
        sessionSaveApprovals,
        sessionRunApprovals,
        pathEdits,
        setPathEdits,
        runningTestFor,
        clearSessionApprovals,
        handleHITLAction,
        handleSaveApproval,
        handleRunApproval,
        handleRunSavedTest,
        saveTestMutation,
        isMutationPending:
            continueHitlMutation.isPending ||
            saveTestMutation.isPending ||
            runTestMutation.isPending,
    };
}
