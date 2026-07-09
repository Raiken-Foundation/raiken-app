/**
 * Named session snapshots for the interactive REPL.
 *
 * The live transcript still lives at `.raiken/chat-history.json` (shared with
 * the dashboard). Snapshots under `.raiken/sessions/` let you save / list /
 * resume named threads — Codex-style continuity without a full TUI.
 */

import fs from "node:fs";
import path from "node:path";

export interface ChatMessage {
    role: string;
    content: string;
}

export interface SessionSnapshot {
    id: string;
    name: string;
    updatedAt: number;
    createdAt: number;
    messages: ChatMessage[];
    /** Optional permission mode remembered with the session. */
    permissionMode?: string;
}

const HISTORY_LIMIT = 200;
const SESSIONS_DIR = "sessions";
const LIVE_HISTORY = "chat-history.json";
const CURRENT_POINTER = "sessions/current.json";

function raikenDir(projectPath: string): string {
    return path.join(projectPath, ".raiken");
}

function sessionsDir(projectPath: string): string {
    return path.join(raikenDir(projectPath), SESSIONS_DIR);
}

function liveHistoryPath(projectPath: string): string {
    return path.join(raikenDir(projectPath), LIVE_HISTORY);
}

function currentPointerPath(projectPath: string): string {
    return path.join(raikenDir(projectPath), CURRENT_POINTER);
}

function ensureSessionsDir(projectPath: string): void {
    fs.mkdirSync(sessionsDir(projectPath), { recursive: true });
}

function slugify(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return slug || `session-${Date.now()}`;
}

function atomicWrite(file: string, payload: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, "utf-8");
    fs.renameSync(tmp, file);
}

/** Load the live chat transcript (dashboard-compatible). */
export function loadLiveHistory(projectPath: string): ChatMessage[] {
    return loadHistoryFile(liveHistoryPath(projectPath));
}

/** Persist the live chat transcript. */
export function saveLiveHistory(projectPath: string, history: ChatMessage[]): void {
    try {
        const payload = JSON.stringify({ messages: history.slice(-HISTORY_LIMIT) }, null, 2);
        atomicWrite(liveHistoryPath(projectPath), payload);
    } catch {
        /* disk not writable — non-critical */
    }
}

function loadHistoryFile(file: string): ChatMessage[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        const arr = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.messages)
              ? parsed.messages
              : null;
        if (arr) {
            return arr
                .filter(
                    (m: unknown): m is ChatMessage =>
                        !!m &&
                        typeof (m as ChatMessage).role === "string" &&
                        typeof (m as ChatMessage).content === "string",
                )
                .slice(-HISTORY_LIMIT);
        }
    } catch {
        /* missing or unreadable */
    }
    return [];
}

function sessionPath(projectPath: string, id: string): string {
    return path.join(sessionsDir(projectPath), `${id}.json`);
}

/** List saved session snapshots, newest first. */
export function listSessions(projectPath: string): SessionSnapshot[] {
    try {
        ensureSessionsDir(projectPath);
        const files = fs.readdirSync(sessionsDir(projectPath)).filter((f) => f.endsWith(".json"));
        const sessions: SessionSnapshot[] = [];
        for (const file of files) {
            if (file === "current.json") continue;
            try {
                const raw = JSON.parse(
                    fs.readFileSync(path.join(sessionsDir(projectPath), file), "utf-8"),
                ) as SessionSnapshot;
                if (raw?.id && Array.isArray(raw.messages)) sessions.push(raw);
            } catch {
                /* skip corrupt */
            }
        }
        return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

/** Save (or overwrite) a named snapshot of the current history. */
export function saveSession(
    projectPath: string,
    name: string,
    messages: ChatMessage[],
    permissionMode?: string,
): SessionSnapshot {
    ensureSessionsDir(projectPath);
    const id = slugify(name);
    const existing = loadSession(projectPath, id);
    const now = Date.now();
    const snap: SessionSnapshot = {
        id,
        name: name.trim() || id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages: messages.slice(-HISTORY_LIMIT),
        permissionMode,
    };
    atomicWrite(sessionPath(projectPath, id), JSON.stringify(snap, null, 2));
    setCurrentSessionId(projectPath, id);
    return snap;
}

/** Load a session by id or name (case-insensitive name match). */
function loadSession(projectPath: string, idOrName: string): SessionSnapshot | null {
    const needle = idOrName.trim().toLowerCase();
    if (!needle) return null;

    // Direct id hit
    try {
        const direct = path.join(sessionsDir(projectPath), `${needle}.json`);
        if (fs.existsSync(direct)) {
            return JSON.parse(fs.readFileSync(direct, "utf-8")) as SessionSnapshot;
        }
    } catch {
        /* fall through */
    }

    const all = listSessions(projectPath);
    return (
        all.find((s) => s.id === needle) ||
        all.find((s) => s.name.toLowerCase() === needle) ||
        all.find((s) => s.name.toLowerCase().includes(needle)) ||
        null
    );
}

/** Most recently updated session, or null. */
function getLatestSession(projectPath: string): SessionSnapshot | null {
    const all = listSessions(projectPath);
    return all[0] ?? null;
}

export function setCurrentSessionId(projectPath: string, id: string | null): void {
    try {
        if (!id) {
            const p = currentPointerPath(projectPath);
            if (fs.existsSync(p)) fs.unlinkSync(p);
            return;
        }
        atomicWrite(currentPointerPath(projectPath), JSON.stringify({ id }, null, 2));
    } catch {
        /* ignore */
    }
}

function getCurrentSessionId(projectPath: string): string | null {
    try {
        const raw = JSON.parse(fs.readFileSync(currentPointerPath(projectPath), "utf-8")) as {
            id?: string;
        };
        return typeof raw.id === "string" ? raw.id : null;
    } catch {
        return null;
    }
}

/**
 * Resolve what to resume: explicit id/name, else current pointer, else latest
 * snapshot, else the live chat-history transcript as a synthetic session.
 */
export function resolveResumeTarget(
    projectPath: string,
    idOrName?: string,
): { messages: ChatMessage[]; label: string; session: SessionSnapshot | null } {
    if (idOrName) {
        const snap = loadSession(projectPath, idOrName);
        if (snap) {
            return { messages: snap.messages, label: snap.name, session: snap };
        }
        return { messages: [], label: idOrName, session: null };
    }

    const currentId = getCurrentSessionId(projectPath);
    if (currentId) {
        const snap = loadSession(projectPath, currentId);
        if (snap) {
            return { messages: snap.messages, label: snap.name, session: snap };
        }
    }

    const latest = getLatestSession(projectPath);
    if (latest) {
        return { messages: latest.messages, label: latest.name, session: latest };
    }

    const live = loadLiveHistory(projectPath);
    if (live.length > 0) {
        return {
            messages: live,
            label: "last chat",
            session: null,
        };
    }

    return { messages: [], label: "empty", session: null };
}

export function previewMessage(messages: ChatMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (!last) return "(no messages)";
    const text = last.content.replace(/\s+/g, " ").trim();
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
