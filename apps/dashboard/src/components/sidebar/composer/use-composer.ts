import { useEffect, useRef, useState } from "react";
import {
    type DashboardRoute,
    findSlashCommand,
    parseSlashInput,
    type SidebarTab,
    type SlashCommand,
    type SlashContext,
} from "../../../utils/slash-commands";
import { trpc } from "../../../utils/trpc";
import { COMPOSER_MAX_HEIGHT_PX } from "../constants";
import type { Message } from "../types";
import {
    checkFileMentionAutocomplete,
    checkSlashAutocomplete,
    insertFileMention,
} from "./mention-utils";

interface UseComposerOptions {
    initialPrompt?: string;
    onInitialPromptConsumed?: () => void;
    isGenerating: boolean;
    sourceFiles: Array<{ path: string; name: string }>;
    onNavigateRoute?: (route: DashboardRoute) => void;
    onTabChange?: (tab: SidebarTab) => void;
    handleClearChat: () => void;
    echoSystemMessage: (markdown: string) => void;
    handleStop: () => boolean;
}

export function useComposer({
    initialPrompt,
    onInitialPromptConsumed,
    isGenerating,
    sourceFiles,
    onNavigateRoute,
    onTabChange,
    handleClearChat,
    echoSystemMessage,
    handleStop,
}: UseComposerOptions) {
    const trpcUtils = trpc.useUtils();
    const [inputValue, setInputValue] = useState(initialPrompt ?? "");
    const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);
    const [showAutocomplete, setShowAutocomplete] = useState(false);
    const [autocompletePosition, setAutocompletePosition] = useState(0);
    const [filteredFiles, setFilteredFiles] = useState<Array<{ path: string; name: string }>>([]);
    const [showSlashAutocomplete, setShowSlashAutocomplete] = useState(false);
    const [slashPosition, setSlashPosition] = useState(0);
    const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const formRef = useRef<HTMLFormElement>(null);

    useEffect(() => {
        if (initialPrompt) {
            setInputValue(initialPrompt);
            onInitialPromptConsumed?.();
            setPendingAutoSubmit(true);
        }
    }, [initialPrompt, onInitialPromptConsumed]);

    useEffect(() => {
        if (pendingAutoSubmit && inputValue && !isGenerating) {
            setPendingAutoSubmit(false);
            const timer = setTimeout(() => {
                formRef.current?.requestSubmit();
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [pendingAutoSubmit, inputValue, isGenerating]);

    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
    }, [inputValue]);

    const checkAndShowAutocomplete = (value: string, cursorPos: number) => {
        if (
            checkSlashAutocomplete(
                value,
                setShowSlashAutocomplete,
                setSlashMatches,
                setSlashPosition,
            )
        ) {
            setShowAutocomplete(false);
            return;
        }
        checkFileMentionAutocomplete(
            value,
            cursorPos,
            sourceFiles,
            setShowAutocomplete,
            setFilteredFiles,
            setAutocompletePosition,
        );
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setInputValue(value);
        checkAndShowAutocomplete(value, e.target.selectionStart || 0);
    };

    const handleInputClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        checkAndShowAutocomplete(inputValue, (e.target as HTMLTextAreaElement).selectionStart || 0);
    };

    const selectFile = (
        file: { path: string; name: string },
        event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
        event?.preventDefault();
        event?.stopPropagation();
        const cursorPos = inputRef.current?.selectionStart || 0;
        const { value, cursorPos: newCursorPos } = insertFileMention(inputValue, cursorPos, file);
        setInputValue(value);
        setShowAutocomplete(false);
        setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        }, 10);
    };

    const selectSlashCommand = (
        cmd: SlashCommand,
        event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
        event?.preventDefault();
        event?.stopPropagation();
        const needsArgs = Boolean(cmd.argsHint);
        const trailing = needsArgs ? " " : "";
        setInputValue(`/${cmd.name}${trailing}`);
        setShowSlashAutocomplete(false);
        setTimeout(() => {
            inputRef.current?.focus();
            const pos = cmd.name.length + 1 + trailing.length;
            inputRef.current?.setSelectionRange(pos, pos);
        }, 10);
    };

    const executeSlashCommand = async (
        raw: string,
        setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
        persistMessage: (message: Message) => void,
    ): Promise<boolean> => {
        const parsed = parseSlashInput(raw);
        if (!parsed) return false;
        const cmd = findSlashCommand(parsed.name);

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            content: raw.trim(),
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: true,
        };
        setMessages((prev) => [...prev, userMessage]);
        persistMessage(userMessage);

        if (!cmd) {
            echoSystemMessage(
                `Unknown command \`/${parsed.name}\`. Try \`/help\` for the full list.`,
            );
            return true;
        }

        const ctx: SlashContext = {
            navigate: (route) => onNavigateRoute?.(route),
            setSidebarTab: (tab) => onTabChange?.(tab),
            clearChat: () => handleClearChat(),
            echoSystem: (md) => echoSystemMessage(md),
            stop: () => handleStop(),
            trpcUtils,
        };

        try {
            const result = await cmd.execute(parsed.args, ctx);
            if (result.message) echoSystemMessage(result.message);
        } catch (err) {
            echoSystemMessage(
                `\`/${cmd.name}\` failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return true;
    };

    const handleKeyDown = (
        e: React.KeyboardEvent<HTMLTextAreaElement>,
        onEchoStopping?: () => void,
    ) => {
        if (showSlashAutocomplete) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashPosition((prev) => Math.min(prev + 1, slashMatches.length - 1));
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashPosition((prev) => Math.max(prev - 1, 0));
                return;
            }
            if (e.key === "Tab") {
                e.preventDefault();
                const pick = slashMatches[slashPosition];
                if (pick) selectSlashCommand(pick, e);
                return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
                // The dropdown advertises "enter to run" — honor the highlighted
                // command, not just the raw typed text. Without this, "/doc" +
                // arrow-down + Enter submits the partial "/doc" (an "unknown
                // command") instead of the highlighted /doctor. Commands that
                // take args only complete (same as Tab) so Enter can't fire
                // them off empty-handed.
                const pick = slashMatches[slashPosition];
                if (pick) {
                    e.preventDefault();
                    if (pick.argsHint) {
                        selectSlashCommand(pick, e);
                    } else {
                        setInputValue(`/${pick.name}`);
                        setShowSlashAutocomplete(false);
                        setTimeout(() => formRef.current?.requestSubmit(), 0);
                    }
                    return;
                }
                // No matches — fall through and let normal submit report the
                // unknown command.
            }
            if (e.key === "Escape") {
                setShowSlashAutocomplete(false);
                return;
            }
        } else if (showAutocomplete) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setAutocompletePosition((prev) => Math.min(prev + 1, filteredFiles.length - 1));
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setAutocompletePosition((prev) => Math.max(prev - 1, 0));
                return;
            }
            if (e.key === "Enter" && filteredFiles.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                selectFile(filteredFiles[autocompletePosition], e);
                return;
            }
            if (e.key === "Escape") {
                setShowAutocomplete(false);
                return;
            }
        }

        if (e.key === "Escape" && isGenerating) {
            e.preventDefault();
            if (handleStop()) onEchoStopping?.();
            return;
        }

        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            formRef.current?.requestSubmit();
        }
    };

    return {
        inputValue,
        setInputValue,
        inputRef,
        formRef,
        showAutocomplete,
        showSlashAutocomplete,
        slashMatches,
        slashPosition,
        setSlashPosition,
        filteredFiles,
        autocompletePosition,
        setAutocompletePosition,
        handleInputChange,
        handleInputClick,
        handleKeyDown,
        selectFile,
        selectSlashCommand,
        executeSlashCommand,
    };
}
