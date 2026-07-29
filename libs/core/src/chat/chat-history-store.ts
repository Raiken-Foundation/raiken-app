import * as fs from "node:fs";
import * as path from "node:path";

export interface ChatHistoryMessage {
    id: string;
    content: string;
    sender: "user" | "assistant";
    timestamp: number;
    fileMentions?: string[];
}

export class ChatHistoryStore {
    static readonly maxMessages = 500;
    private readonly cache = new Map<string, ChatHistoryMessage[]>();

    list(projectPath: string): ChatHistoryMessage[] {
        const key = path.resolve(projectPath);
        if (!this.cache.has(key)) this.cache.set(key, this.load(key));
        return [...(this.cache.get(key) ?? [])];
    }

    append(projectPath: string, message: ChatHistoryMessage): number {
        const key = path.resolve(projectPath);
        const messages = this.list(key);
        const existing = message.id
            ? messages.findIndex((candidate) => candidate.id === message.id)
            : -1;
        if (existing >= 0) messages[existing] = message;
        else messages.push(message);
        if (messages.length > ChatHistoryStore.maxMessages) {
            messages.splice(0, messages.length - ChatHistoryStore.maxMessages);
        }
        this.cache.set(key, messages);
        this.persist(key, messages);
        return messages.length;
    }

    clear(projectPath: string): void {
        const key = path.resolve(projectPath);
        this.cache.set(key, []);
        this.persist(key, []);
    }

    private historyPath(projectPath: string): string {
        return path.join(projectPath, ".raiken", "chat-history.json");
    }

    private load(projectPath: string): ChatHistoryMessage[] {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.historyPath(projectPath), "utf-8")) as
                | { messages?: ChatHistoryMessage[] }
                | ChatHistoryMessage[];
            if (Array.isArray(parsed)) return parsed;
            return Array.isArray(parsed.messages) ? parsed.messages : [];
        } catch {
            return [];
        }
    }

    private persist(projectPath: string, messages: ChatHistoryMessage[]): void {
        const target = this.historyPath(projectPath);
        const directory = path.dirname(target);
        fs.mkdirSync(directory, { recursive: true });
        const temporary = path.join(
            directory,
            `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`,
        );
        try {
            fs.writeFileSync(temporary, JSON.stringify({ messages }, null, 2), "utf-8");
            fs.renameSync(temporary, target);
        } catch (error) {
            fs.rmSync(temporary, { force: true });
            throw error;
        }
    }
}

export const chatHistoryStore = new ChatHistoryStore();
