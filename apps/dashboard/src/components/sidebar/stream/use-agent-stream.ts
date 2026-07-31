import {
    type AgentStreamErrorField,
    agentStreamErrorMessage,
    parseAgentStreamError,
    type SseAgentStreamEvent,
} from "@raiken/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { serverAuthHeaders } from "../../../utils/api-auth";
import { readSseJsonStream } from "../../../utils/sse";
import { buildConversationWindow } from "../chat/conversation";
import {
    formatInterruptedAssistantMessage,
    parseStreamedAssistantContent,
} from "../stream/parse-stream";
import type { Message } from "../types";

export type AgentStreamEvent = SseAgentStreamEvent;

/** Thrown when the SSE stream emits an error event (string or structured). */
export class AgentStreamError extends Error {
    readonly raikenCode?: string;
    readonly retryable?: boolean;
    readonly correlationId?: string;
    readonly operationId?: string;
    readonly workflowId?: string;

    constructor(error: AgentStreamErrorField) {
        const parsed = parseAgentStreamError(error);
        super(parsed.message);
        this.name = "AgentStreamError";
        this.raikenCode = parsed.raikenCode ?? parsed.code;
        this.retryable = parsed.retryable;
        this.correlationId = parsed.correlationId;
        this.operationId = parsed.operationId;
        this.workflowId = parsed.workflowId;
    }
}

export async function parseFailedAgentResponse(response: Response): Promise<AgentStreamError> {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (body && typeof body === "object") {
        const payload = body as { error?: unknown; detail?: unknown; raiken?: unknown };
        if (payload.raiken && typeof payload.raiken === "object" && "message" in payload.raiken) {
            return new AgentStreamError(payload.raiken as AgentStreamErrorField);
        }
        if (typeof payload.error === "string") {
            return new AgentStreamError(payload.error);
        }
        if (typeof payload.detail === "string") {
            return new AgentStreamError(payload.detail);
        }
    }
    return new AgentStreamError(`Failed to generate test (${response.status})`);
}

export interface AgentStreamRequest {
    prompt: string;
    fileContext?: string[];
    conversationHistory?: Array<{ role: string; content: string }>;
    targetTestFile?: string;
}

export interface AgentStreamCallbacks {
    onChunk?: (accumulated: string) => void;
    onComplete?: (accumulated: string, aiMessageId: string) => void;
    onError?: (accumulated: string, aiMessageId: string, error: unknown) => void;
}

export function useAgentStream() {
    const abortControllerRef = useRef<AbortController | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);

    const handleStop = useCallback((): boolean => {
        const controller = abortControllerRef.current;
        if (!controller) return false;
        controller.abort();
        abortControllerRef.current = null;
        return true;
    }, []);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
        };
    }, []);

    const runStream = useCallback(
        async (
            request: AgentStreamRequest,
            aiMessageId: string,
            setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
            callbacks?: AgentStreamCallbacks,
        ) => {
            // A new turn supersedes whatever is still streaming. Without this
            // the previous stream keeps writing to its message, and its
            // `finally` clears `isGenerating` and the abort ref out from under
            // this one — leaving the Stop button wired to nothing.
            abortControllerRef.current?.abort();

            const controller = new AbortController();
            abortControllerRef.current = controller;
            setIsGenerating(true);
            let accumulated = "";

            try {
                const response = await fetch("/api/generate-test", {
                    method: "POST",
                    headers: serverAuthHeaders({ "Content-Type": "application/json" }),
                    signal: controller.signal,
                    body: JSON.stringify(request),
                });

                if (!response.ok) {
                    throw await parseFailedAgentResponse(response);
                }
                if (!response.body) {
                    throw new Error("No response body");
                }

                for await (const data of readSseJsonStream<AgentStreamEvent>(response.body)) {
                    if (data.error) {
                        throw new AgentStreamError(data.error);
                    }
                    if (!data.chunk) continue;

                    accumulated += data.chunk;
                    callbacks?.onChunk?.(accumulated);

                    const {
                        clean: displayContent,
                        activity,
                        hitl,
                    } = parseStreamedAssistantContent(accumulated);
                    const hitlData = hitl ?? undefined;
                    const hasText = displayContent.trim().length > 0;
                    const resolvedContent = hitlData ? "" : displayContent;

                    setMessages((prev) =>
                        prev.map((msg) =>
                            msg.id === aiMessageId
                                ? {
                                      ...msg,
                                      content: resolvedContent,
                                      isLoading: !hasText && !hitlData,
                                      hitlData,
                                      activity,
                                  }
                                : msg,
                        ),
                    );
                }

                callbacks?.onComplete?.(accumulated, aiMessageId);
            } catch (error) {
                callbacks?.onError?.(accumulated, aiMessageId, error);
            } finally {
                // Only the stream that still owns the ref may reset shared
                // state; a superseded one must leave the newer run alone.
                if (abortControllerRef.current === controller) {
                    abortControllerRef.current = null;
                    setIsGenerating(false);
                }
            }
        },
        [],
    );

    return {
        isGenerating,
        setIsGenerating,
        handleStop,
        runStream,
        abortControllerRef,
    };
}

export function buildHitlStreamRequest(
    actionId: string,
    context: { url?: string; files?: string[] },
    messages: Message[],
): AgentStreamRequest {
    return {
        prompt: `HITL_ACTION:${actionId}:${JSON.stringify(context)}`,
        fileContext: context.files ?? [],
        conversationHistory: buildConversationWindow(messages),
    };
}

export function applyStreamError(
    accumulated: string,
    aiMessageId: string,
    error: unknown,
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): string {
    const stopped = error instanceof DOMException && error.name === "AbortError";
    if (!stopped) console.error("Agent stream failed:", error);
    const errorMessage =
        error instanceof AgentStreamError
            ? error.message
            : error instanceof Error
              ? error.message
              : agentStreamErrorMessage(String(error));
    const interruptedContent = formatInterruptedAssistantMessage(
        accumulated,
        errorMessage,
        stopped,
    );
    setMessages((prev) =>
        prev.map((msg) =>
            msg.id === aiMessageId
                ? { ...msg, content: interruptedContent, isLoading: false }
                : msg,
        ),
    );
    return interruptedContent;
}

export function isCompleteTestFile(content: string): boolean {
    const hasPlaywrightImport =
        content.includes("import { test") && content.includes("@playwright/test");
    const hasTestStructure =
        content.includes("test.describe(") ||
        (content.includes("describe(") && content.includes("test("));
    const hasTest = (content.match(/\btest\s*\(/g) || []).length >= 1;
    const isHITLConfirmation = content.includes("<!--HITL:");
    return hasPlaywrightImport && hasTestStructure && hasTest && !isHITLConfirmation;
}
