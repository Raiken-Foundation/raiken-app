import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../../../utils/trpc";
import { CHAT_SYNC_POLL_MS, resolveVisiblePollInterval, WELCOME_MESSAGE } from "../constants";
import type { Message } from "../types";
import { mapServerChatMessage, mergeChatMessages } from "./message-mapper";

export function useChatThread(isGenerating: boolean) {
    const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
    const [messagesLoaded, setMessagesLoaded] = useState(false);
    const lastServerCountRef = useRef(0);
    const utils = trpc.useUtils();

    const { data: chatData } = trpc.getChatMessages.useQuery(undefined, {
        refetchOnWindowFocus: true,
        refetchInterval: () => {
            if (isGenerating) return false;
            return resolveVisiblePollInterval(CHAT_SYNC_POLL_MS, CHAT_SYNC_POLL_MS, false);
        },
    });
    const serverMessages = chatData?.messages;

    const addMessageMutation = trpc.addChatMessage.useMutation();
    const clearMessagesMutation = trpc.clearChatMessages.useMutation();

    useEffect(() => {
        if (!serverMessages) return;

        const mapped = serverMessages.map(mapServerChatMessage);

        if (!messagesLoaded) {
            if (serverMessages.length > 0) {
                setMessages([WELCOME_MESSAGE, ...mapped]);
            }
            setMessagesLoaded(true);
            lastServerCountRef.current = serverMessages.length;
            return;
        }

        if (isGenerating || serverMessages.length === lastServerCountRef.current) return;

        lastServerCountRef.current = serverMessages.length;
        setMessages((current) => mergeChatMessages(current, mapped));
    }, [serverMessages, messagesLoaded, isGenerating]);

    const persistMessage = useCallback(
        (message: Message) => {
            addMessageMutation.mutate({
                id: message.id,
                content: message.content,
                sender: message.isUser ? "user" : "assistant",
                timestamp: Date.now(),
                fileMentions: message.fileMentions,
            });
        },
        [addMessageMutation],
    );

    const echoSystemMessage = useCallback(
        (markdown: string) => {
            if (!markdown) return;
            const message: Message = {
                id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                content: markdown,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, message]);
            persistMessage(message);
        },
        [persistMessage],
    );

    const handleClearChat = useCallback(() => {
        clearMessagesMutation.mutate(undefined, {
            onSuccess: () => {
                setMessages([WELCOME_MESSAGE]);
                lastServerCountRef.current = 0;
                // The query cache still holds the deleted thread. Left alone,
                // the next re-render that re-runs the sync effect (e.g. when
                // `isGenerating` flips) would merge those messages back in.
                utils.getChatMessages.setData(undefined, { messages: [] });
                void utils.getChatMessages.invalidate();
            },
        });
    }, [clearMessagesMutation, utils]);

    return {
        messages,
        setMessages,
        messagesLoaded,
        persistMessage,
        echoSystemMessage,
        handleClearChat,
    };
}
