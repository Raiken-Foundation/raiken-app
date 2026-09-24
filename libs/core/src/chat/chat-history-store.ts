import * as fs from "node:fs";
import * as path from "node:path";
import { lockSync as lockfileLockSync } from "proper-lockfile";

export interface ChatHistoryMessage {
    id: string;
    content: string;
    sender: "user" | "assistant";
    timestamp: number;
    fileMentions?: string[];
}

/** Legacy REPL / session snapshot shape before contract unification. */
export interface LegacyChatMessage {
    role: string;
    content: string;
}

/** REPL in-memory message: legacy shape plus optional canonical metadata. */
export interface ReplChatMessage extends LegacyChatMessage {
    id?: string;
    timestamp?: number;
    fileMentions?: string[];
}

interface CacheEntry {
    mtimeMs: number;
    messages: ChatHistoryMessage[];
}

function senderFromRole(role: string): "user" | "assistant" {
    return role === "assistant" ? "assistant" : "user";
}

function roleFromSender(sender: ChatHistoryMessage["sender"]): string {
    return sender;
}

export function toLegacyChatMessage(message: ChatHistoryMessage): LegacyChatMessage {
    return {
        role: roleFromSender(message.sender),
        content: message.content,
    };
}

export function toReplChatMessage(message: ChatHistoryMessage): ReplChatMessage {
    return {
        role: roleFromSender(message.sender),
        content: message.content,
        id: message.id,
        timestamp: message.timestamp,
        ...(message.fileMentions ? { fileMentions: message.fileMentions } : {}),
    };
}

export function fromLegacyChatMessage(
    message: LegacyChatMessage,
    index: number,
    baseTimestamp = Date.now(),
): ChatHistoryMessage {
    return fromReplChatMessage(message, index, baseTimestamp);
}

export function fromReplChatMessage(
    message: ReplChatMessage,
    index: number,
    baseTimestamp = Date.now(),
): ChatHistoryMessage {
    return {
        id: message.id ?? `legacy-${index}-${message.role}`,
        sender: senderFromRole(message.role),
        content: message.content,
        timestamp: message.timestamp ?? baseTimestamp + index,
        ...(message.fileMentions ? { fileMentions: message.fileMentions } : {}),
    };
}

function senderContentKey(sender: ChatHistoryMessage["sender"], content: string): string {
    return `${sender}\0${content}`;
}

export function buildExistingMessageLookups(existing: ChatHistoryMessage[]): {
    byId: Map<string, ChatHistoryMessage>;
    bySenderContent: Map<string, ChatHistoryMessage[]>;
} {
    const byId = new Map<string, ChatHistoryMessage>();
    const bySenderContent = new Map<string, ChatHistoryMessage[]>();
    for (const message of existing) {
        byId.set(message.id, message);
        const key = senderContentKey(message.sender, message.content);
        const bucket = bySenderContent.get(key) ?? [];
        bucket.push(message);
        bySenderContent.set(key, bucket);
    }
    return { byId, bySenderContent };
}

/** Resolve a REPL message to canonical form, reusing stable ids when possible. */
export function resolveReplToCanonical(
    message: ReplChatMessage,
    index: number,
    baseTimestamp: number,
    lookups: ReturnType<typeof buildExistingMessageLookups>,
    consumedIds: Set<string>,
): ChatHistoryMessage {
    const sender = senderFromRole(message.role);

    if (message.id) {
        const prior = lookups.byId.get(message.id);
        if (prior && prior.sender === sender) {
            consumedIds.add(prior.id);
            return {
                ...prior,
                content: message.content,
                fileMentions: message.fileMentions ?? prior.fileMentions,
            };
        }
    }

    const key = senderContentKey(sender, message.content);
    const candidates = (lookups.bySenderContent.get(key) ?? []).filter(
        (candidate) => !consumedIds.has(candidate.id),
    );
    if (candidates.length === 1) {
        consumedIds.add(candidates[0].id);
        return candidates[0];
    }
    if (candidates.length > 1 && message.timestamp !== undefined) {
        const byTimestamp = candidates.find(
            (candidate) => candidate.timestamp === message.timestamp,
        );
        if (byTimestamp) {
            consumedIds.add(byTimestamp.id);
            return byTimestamp;
        }
    }

    return fromReplChatMessage(message, index, baseTimestamp);
}

function isLegacyChatMessage(value: unknown): value is LegacyChatMessage {
    return (
        !!value &&
        typeof value === "object" &&
        "role" in value &&
        typeof (value as LegacyChatMessage).role === "string" &&
        "content" in value &&
        typeof (value as LegacyChatMessage).content === "string" &&
        !("sender" in value)
    );
}

function isCanonicalChatMessage(value: unknown): value is ChatHistoryMessage {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as ChatHistoryMessage).id === "string" &&
        typeof (value as ChatHistoryMessage).content === "string" &&
        ((value as ChatHistoryMessage).sender === "user" ||
            (value as ChatHistoryMessage).sender === "assistant") &&
        typeof (value as ChatHistoryMessage).timestamp === "number"
    );
}

/**
 * Move an unparseable transcript aside so the next write cannot silently
 * destroy it. Reads afterwards see a missing file and start a fresh history.
 */
function quarantineCorruptFile(target: string): void {
    try {
        fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
        console.warn(
            `[ChatHistory] ${target} was not readable JSON and was preserved alongside a fresh transcript.`,
        );
    } catch {
        /* best effort: a transcript we cannot move is one we also cannot repair */
    }
}

function readRawFile(projectPath: string): { raw: unknown[]; wrapped: boolean } {
    const target = historyPath(projectPath);
    let contents: string;
    try {
        contents = fs.readFileSync(target, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: [], wrapped: true };
        throw error;
    }

    if (contents.trim() === "") return { raw: [], wrapped: true };

    try {
        const parsed = JSON.parse(contents) as { messages?: unknown[] } | unknown[];
        if (Array.isArray(parsed)) return { raw: parsed, wrapped: false };
        return {
            raw: Array.isArray(parsed.messages) ? parsed.messages : [],
            wrapped: true,
        };
    } catch {
        quarantineCorruptFile(target);
        return { raw: [], wrapped: true };
    }
}

function normalizeMessages(raw: unknown[]): ChatHistoryMessage[] {
    if (!raw.some(isLegacyChatMessage)) {
        return raw.filter(isCanonicalChatMessage);
    }
    const baseTimestamp = Date.now() - raw.length;
    let legacyIndex = 0;
    return raw.flatMap((item) => {
        if (isCanonicalChatMessage(item)) return [item];
        if (isLegacyChatMessage(item)) {
            const converted = fromLegacyChatMessage(item, legacyIndex, baseTimestamp);
            legacyIndex += 1;
            return [converted];
        }
        return [];
    });
}

function historyPath(projectPath: string): string {
    return path.join(projectPath, ".raiken", "chat-history.json");
}

function fileMtimeMs(projectPath: string): number | null {
    try {
        return fs.statSync(historyPath(projectPath)).mtimeMs;
    } catch {
        return null;
    }
}

function atomicWriteJson(projectPath: string, messages: ChatHistoryMessage[]): number {
    const target = historyPath(projectPath);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(
        directory,
        `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`,
    );
    try {
        fs.writeFileSync(temporary, JSON.stringify({ messages }, null, 2), "utf-8");
        fs.renameSync(temporary, target);
        return fs.statSync(target).mtimeMs;
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function acquireHistoryLock(projectPath: string): () => void {
    const target = historyPath(projectPath);
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            return lockfileLockSync(target, {
                realpath: false,
                stale: 5_000,
            });
        } catch (error) {
            lastError = error;
            if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
            Atomics.wait(lockWaitBuffer, 0, 0, 5 + attempt * 2);
        }
    }
    throw lastError;
}

export class ChatHistoryStore {
    static readonly maxMessages = 500;
    private readonly cache = new Map<string, CacheEntry>();

    list(projectPath: string): ChatHistoryMessage[] {
        const key = path.resolve(projectPath);
        const mtimeMs = fileMtimeMs(key);
        const cached = this.cache.get(key);
        if (cached && mtimeMs !== null && cached.mtimeMs === mtimeMs) {
            return [...cached.messages];
        }

        const { raw, wrapped } = readRawFile(key);
        const needsLegacyMigration = raw.some(isLegacyChatMessage);
        const needsFormatMigration = !wrapped;
        if (needsLegacyMigration || needsFormatMigration) {
            // Migration is a read-modify-write, so it has to take the same lock
            // every other write takes or it can clobber a concurrent append.
            return this.updateAtomically(key, (current) => current);
        }

        const messages = normalizeMessages(raw);
        this.cache.set(key, { mtimeMs: mtimeMs ?? 0, messages });
        return [...messages];
    }

    replaceAll(projectPath: string, messages: ChatHistoryMessage[]): void {
        this.updateAtomically(projectPath, () => messages);
    }

    /**
     * Serialize cross-process read/modify/write operations and atomically
     * replace the canonical transcript with the updater result.
     */
    updateAtomically(
        projectPath: string,
        update: (messages: ChatHistoryMessage[]) => ChatHistoryMessage[],
    ): ChatHistoryMessage[] {
        const key = path.resolve(projectPath);
        fs.mkdirSync(path.dirname(historyPath(key)), { recursive: true });
        const release = acquireHistoryLock(key);
        try {
            const { raw } = readRawFile(key);
            const messages = update(normalizeMessages(raw));
            const trimmed =
                messages.length > ChatHistoryStore.maxMessages
                    ? messages.slice(-ChatHistoryStore.maxMessages)
                    : messages;
            const mtimeMs = atomicWriteJson(key, trimmed);
            this.cache.set(key, { mtimeMs, messages: trimmed });
            return [...trimmed];
        } finally {
            release();
        }
    }

    append(projectPath: string, message: ChatHistoryMessage): number {
        const updated = this.updateAtomically(projectPath, (messages) => {
            const next = [...messages];
            const existing = message.id
                ? next.findIndex((candidate) => candidate.id === message.id)
                : -1;
            if (existing >= 0) next[existing] = message;
            else next.push(message);
            return next;
        });
        return updated.length;
    }

    clear(projectPath: string): void {
        this.updateAtomically(projectPath, () => []);
    }

    /** Drop cached state so the next read reflects on-disk contents. */
    invalidate(projectPath: string): void {
        this.cache.delete(path.resolve(projectPath));
    }
}

export const chatHistoryStore = new ChatHistoryStore();
