import { CONVERSATION_WINDOW } from "../constants";
import type { Message } from "../types";

export function buildConversationWindow(
    messages: Message[],
): Array<{ role: string; content: string }> {
    const relevant = messages.filter((m) => m.id !== "welcome" && m.content.trim().length > 0);
    const recent = relevant.slice(-CONVERSATION_WINDOW);
    const out = recent.map((m) => ({
        role: m.isUser ? "user" : "assistant",
        content: m.content,
    }));
    const firstUser = relevant.find((m) => m.isUser);
    if (firstUser && !recent.includes(firstUser)) {
        out.unshift({ role: "user", content: `[Original request] ${firstUser.content}` });
    }
    return out;
}
