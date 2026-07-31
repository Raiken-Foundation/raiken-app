import { extractHitlMarker } from "@raiken/shared";
import type { HITLConfirmation, Message } from "../types";

export function formatMessageTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function mapServerChatMessage(msg: {
    id: string;
    content: string;
    sender: "user" | "assistant";
    timestamp: number;
    fileMentions?: string[];
}): Message {
    const baseMessage: Message = {
        id: msg.id,
        content: msg.content,
        timestamp: formatMessageTimestamp(msg.timestamp),
        isUser: msg.sender === "user",
        fileMentions: msg.fileMentions,
    };
    if (!msg.content || msg.sender === "user") return baseMessage;
    const hitlMatch = msg.content.match(/<!--HITL:([\s\S]+?)-->/);
    if (!hitlMatch) return baseMessage;
    const { clean, hitl } = extractHitlMarker(msg.content);
    if (!hitl) return baseMessage;
    return {
        ...baseMessage,
        content: clean.trim(),
        hitlData: hitl as unknown as HITLConfirmation,
    };
}

/**
 * Merge canonical server messages into local state without clobbering an
 * in-flight streamed assistant message or reordering the welcome banner.
 */
export function mergeChatMessages(local: Message[], serverMessages: Message[]): Message[] {
    const welcome = local.find((message) => message.id === "welcome");
    const streaming = local.filter((message) => message.isLoading);
    const streamingIds = new Set(streaming.map((message) => message.id));
    const serverIds = new Set(serverMessages.map((message) => message.id));

    const canonical = serverMessages.filter((message) => !streamingIds.has(message.id));

    for (const message of local) {
        if (message.id === "welcome" || message.isLoading || serverIds.has(message.id)) continue;
        canonical.push(message);
    }

    const merged: Message[] = [...(welcome ? [welcome] : []), ...canonical, ...streaming];
    return merged;
}
