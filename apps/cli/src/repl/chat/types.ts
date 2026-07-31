import type readline from "node:readline";
import type { ProjectApplication } from "@raiken/core";
import type { PermissionMode } from "../permissions";
import type { InputQueue } from "../queue";
import type { ChatMessage } from "../sessions";
import type { startThinking } from "../thinking";
import type { ToolCallRenderer } from "../tool-renderer";

/** Mutable REPL session state — injected, not module-global. */
export interface ChatReplState {
    history: ChatMessage[];
    /** IDs present after the last successful disk sync. */
    persistedHistoryIds: Set<string>;
    activeSessionName: string | null;
    permissionMode: PermissionMode;
    planMode: boolean;
    verboseTools: boolean;
    closing: boolean;
    turnActive: boolean;
    readingUserInput: boolean;
    currentAbort: AbortController | null;
    promptCancel: (() => void) | null;
    activePromptAnswer: ((line: string) => void) | null;
    pendingLines: string[];
    exitArmedUntil: number;
    thinking: ReturnType<typeof startThinking> | null;
    activeReadlinePrompt: string;
    /** Session resources finalized (persist + browser close). */
    replFinalized: boolean;
    /** Readline/process listeners removed and interface closed. */
    replTornDown: boolean;
}

export interface ManualSaveWatcher {
    promise: Promise<void>;
    cancel: () => void;
}

/** Services and callbacks shared across REPL modules. */
export interface ChatReplContext {
    projectPath: string;
    app: ProjectApplication;
    state: ChatReplState;
    tools: ToolCallRenderer;
    inputQueue: InputQueue;
    rl: readline.Interface;
    persist: () => void;
    ask: (query: string) => Promise<string>;
    askCancelable: (query: string, secret?: boolean) => Promise<string | null>;
    askSecret: (query: string) => Promise<string | null>;
    readUserInput: () => Promise<string | null>;
    ensureBrowser: () => Promise<import("@raiken/core").BrowserSession>;
    shutdown: () => Promise<void>;
    createManualSaveWatcher: () => ManualSaveWatcher;
    runParity: (label: string, fn: () => Promise<void>) => Promise<void>;
    stopThinking: () => void;
}

export interface ChatCommandOptions {
    /** Resume a named session, or `true` for the latest / current. */
    resume?: string | true;
}
