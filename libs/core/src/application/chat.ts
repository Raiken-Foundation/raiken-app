import { clearAgentWorkingMemory } from "../agent/memory";
import { chatHistoryStore } from "../chat/chat-history-store";
import type { ProjectApplicationContext } from "./context";

/** Project-scoped chat persistence and agent working-memory resets. */
export class ChatApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    listMessages() {
        return { messages: chatHistoryStore.list(this.projectPath) };
    }

    appendMessage(input: {
        id: string;
        content: string;
        sender: "user" | "assistant";
        timestamp: number;
        fileMentions?: string[];
    }) {
        const messageCount = chatHistoryStore.append(this.projectPath, input);
        return { success: true, messageCount };
    }

    clearAgentMemory() {
        try {
            clearAgentWorkingMemory(this.projectPath);
        } catch {
            /* memory unavailable */
        }
        return { success: true };
    }

    clearChatMessages() {
        chatHistoryStore.clear(this.projectPath);
        try {
            clearAgentWorkingMemory(this.projectPath);
        } catch {
            /* memory unavailable — chat still cleared */
        }
        return { success: true };
    }
}
