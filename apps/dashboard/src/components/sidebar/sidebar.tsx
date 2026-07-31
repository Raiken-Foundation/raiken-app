import { useEffect, useRef, useState } from "react";
import { trpc } from "../../utils/trpc";
import type { TestFileItem } from "../files-panel";
import { Logo } from "../logo";
import { buildConversationWindow } from "./chat/conversation";
import { useChatThread } from "./chat/use-chat-thread";
import { ChatComposer } from "./composer/chat-composer";
import { collectHistoricalFileMentions, extractFileMentions } from "./composer/mention-utils";
import { useComposer } from "./composer/use-composer";
import { NEAR_BOTTOM_THRESHOLD } from "./constants";
import { SidebarFilesTab } from "./files/sidebar-files-tab";
import { useHitlActions } from "./hitl/use-hitl-actions";
import { useActiveHitlWorkflows, useHitlWorkflowResume } from "./hitl/use-hitl-workflows";
import { computeHitlPending, rehydrateWorkflowHitlCards } from "./hitl/workflow-state";
import { MessageList } from "./messages/message-list";
import { parseStreamedAssistantContent } from "./stream/parse-stream";
import { applyStreamError, isCompleteTestFile, useAgentStream } from "./stream/use-agent-stream";
import type { SidebarProps } from "./types";
import "./sidebar.css";

export function Sidebar({
    onSendMessage,
    onFileSelect,
    activeFilePath,
    activeTab: externalTab,
    collapsed: externalCollapsed,
    onTabChange,
    initialPrompt,
    onInitialPromptConsumed,
    onNavigateRoute,
    onHitlPendingChange,
}: SidebarProps) {
    const activeTab = externalTab ?? "chat";
    const isCollapsed = externalCollapsed ?? false;

    const { isGenerating, setIsGenerating, handleStop, runStream } = useAgentStream();
    const {
        messages,
        setMessages,
        messagesLoaded,
        persistMessage,
        echoSystemMessage,
        handleClearChat,
    } = useChatThread(isGenerating);

    const hitl = useHitlActions({
        setMessages,
        persistMessage,
        onFileSelect,
        refetchTestFiles: () => void refetchTestFiles(),
        setIsGenerating,
        runStream,
        messages,
    });

    const { workflows: activeWorkflows, workflowsAuthoritative } = useActiveHitlWorkflows(
        isGenerating,
        hitl.isMutationPending,
    );
    useHitlWorkflowResume(activeWorkflows);

    const [files, setFiles] = useState<TestFileItem[]>([]);
    const [sourceFiles, setSourceFiles] = useState<Array<{ path: string; name: string }>>([]);
    const messagesRef = useRef<HTMLDivElement>(null);
    const [isNearBottom, setIsNearBottom] = useState(true);

    const {
        data: testFilesData,
        isLoading: filesLoading,
        isFetching: filesRefetching,
        refetch: refetchTestFiles,
    } = trpc.listTestFiles.useQuery({});
    const { data: allFilesData } = trpc.getGraphFiles.useQuery({ limit: 1000, offset: 0 });
    const { data: raikenConfig } = trpc.getConfig.useQuery();

    const composer = useComposer({
        initialPrompt,
        onInitialPromptConsumed,
        isGenerating,
        sourceFiles,
        onNavigateRoute,
        onTabChange,
        handleClearChat: () => {
            hitl.clearSessionApprovals();
            handleClearChat();
        },
        echoSystemMessage,
        handleStop,
    });

    useEffect(() => {
        onHitlPendingChange?.(
            computeHitlPending(
                messages,
                activeWorkflows,
                hitl.sessionSaveApprovals,
                hitl.sessionRunApprovals,
                workflowsAuthoritative,
            ),
        );
    }, [
        messages,
        activeWorkflows,
        workflowsAuthoritative,
        hitl.sessionSaveApprovals,
        hitl.sessionRunApprovals,
        onHitlPendingChange,
    ]);

    useEffect(() => {
        if (!messagesLoaded || activeWorkflows.length === 0) return;
        setMessages((current) => {
            const next = rehydrateWorkflowHitlCards(current, activeWorkflows);
            return next === current ? current : next;
        });
    }, [activeWorkflows, messagesLoaded, setMessages]);

    const testFilesList = testFilesData?.files;
    const graphFilesList = allFilesData?.files;

    useEffect(() => {
        if (!testFilesList) return;
        const converted = testFilesList.map((file, index) => ({
            id: `test-${index}`,
            name: file.name,
            path: file.path,
            directory: file.directory,
            status: file.status,
        }));
        setFiles((current) => {
            if (
                current.length === converted.length &&
                current.every(
                    (file, index) =>
                        file.path === converted[index]?.path &&
                        file.name === converted[index]?.name,
                )
            ) {
                return current;
            }
            return converted;
        });
    }, [testFilesList]);

    useEffect(() => {
        if (!graphFilesList || !testFilesList) return;
        const sourceFilesFromGraph = graphFilesList.map((file) => ({
            path: file.path,
            name: file.path.split("/").pop() || file.path,
        }));
        const testFilesForAutocomplete = testFilesList.map((file) => ({
            path: file.path,
            name: file.name,
        }));
        const allFiles = [...sourceFilesFromGraph, ...testFilesForAutocomplete];
        const unique = Array.from(new Map(allFiles.map((file) => [file.path, file])).values());
        setSourceFiles((current) => {
            if (
                current.length === unique.length &&
                current.every(
                    (file, index) =>
                        file.path === unique[index]?.path && file.name === unique[index]?.name,
                )
            ) {
                return current;
            }
            return unique;
        });
    }, [graphFilesList, testFilesList]);

    useEffect(() => {
        if (!isNearBottom) return;
        const el = messagesRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, isNearBottom]);

    const handleMessagesScroll = () => {
        const el = messagesRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        setIsNearBottom(distanceFromBottom < NEAR_BOTTOM_THRESHOLD);
    };

    const scrollMessagesToBottom = () => {
        const el = messagesRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        setIsNearBottom(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!composer.inputValue.trim()) return;

        if (composer.inputValue.trimStart().startsWith("/")) {
            const parsed = composer.inputValue.trimStart().slice(1).split(/\s/)[0];
            const isStopCommand = ["stop", "abort", "cancel"].includes(parsed);
            if (isGenerating && !isStopCommand) return;
            const raw = composer.inputValue;
            composer.setInputValue("");
            await composer.executeSlashCommand(raw, setMessages, persistMessage);
            return;
        }

        if (isGenerating) return;

        const newFileContext = extractFileMentions(composer.inputValue);
        const conversationHistory = buildConversationWindow(messages);
        const allFileContext = [
            ...new Set([...newFileContext, ...collectHistoricalFileMentions(messages)]),
        ];

        const userMessage = {
            id: Date.now().toString(),
            content: composer.inputValue,
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: true,
            fileMentions: newFileContext.length > 0 ? newFileContext : undefined,
        };

        setMessages((prev) => [...prev, userMessage]);
        persistMessage(userMessage);
        const prompt = composer.inputValue;
        composer.setInputValue("");

        const aiMessageId = (Date.now() + 1).toString();
        setMessages((prev) => [
            ...prev,
            {
                id: aiMessageId,
                content: "",
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
                isLoading: true,
            },
        ]);

        await runStream(
            {
                prompt,
                fileContext: allFileContext,
                conversationHistory,
                targetTestFile:
                    activeFilePath && !activeFilePath.startsWith("scratch:")
                        ? activeFilePath
                        : undefined,
            },
            aiMessageId,
            setMessages,
            {
                onComplete: (accumulated) => {
                    const cleanedFinal = parseStreamedAssistantContent(accumulated).clean;
                    persistMessage({
                        id: aiMessageId,
                        content: cleanedFinal,
                        timestamp: new Date().toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                        isUser: false,
                    });

                    const agentAlreadySaved = Boolean(raikenConfig?.config.autonomy?.autoSaveTests);
                    if (isCompleteTestFile(cleanedFinal)) {
                        if (agentAlreadySaved) {
                            void refetchTestFiles();
                        } else {
                            onSendMessage?.(cleanedFinal);
                        }
                    }
                },
                onError: (accumulated, id, error) => {
                    const interruptedContent = applyStreamError(
                        accumulated,
                        id,
                        error,
                        setMessages,
                    );
                    persistMessage({
                        id,
                        content: interruptedContent,
                        timestamp: new Date().toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                        isUser: false,
                    });
                },
            },
        );
    };

    return (
        <aside className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
            {!isCollapsed && (
                <>
                    {activeTab === "chat" && (
                        <div className="chat-panel">
                            <div className="agent-header">
                                <Logo size={12} bare className="agent-icon" />
                                <div className="agent-info">
                                    <span className="agent-title">raiken/agent</span>
                                    <span className="agent-status">
                                        <span
                                            className={`status-dot ${isGenerating ? "generating" : ""}`}
                                        />
                                        {isGenerating ? "generating…" : "ready"}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    className="clear-chat-btn"
                                    onClick={() => {
                                        hitl.clearSessionApprovals();
                                        handleClearChat();
                                    }}
                                    title="clear chat history"
                                    aria-label="clear chat history"
                                    disabled={messages.length <= 1}
                                >
                                    <svg
                                        aria-hidden="true"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                    >
                                        <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </div>

                            <MessageList
                                messages={messages}
                                messagesRef={messagesRef}
                                onScroll={handleMessagesScroll}
                                isNearBottom={isNearBottom}
                                onScrollToBottom={scrollMessagesToBottom}
                                isGenerating={isGenerating}
                                workflows={activeWorkflows}
                                workflowsAuthoritative={workflowsAuthoritative}
                                sessionSaveApprovals={hitl.sessionSaveApprovals}
                                sessionRunApprovals={hitl.sessionRunApprovals}
                                pathEdits={hitl.pathEdits}
                                setPathEdits={hitl.setPathEdits}
                                saveTestMutation={{
                                    isPending: hitl.isMutationPending,
                                }}
                                runningTestFor={hitl.runningTestFor}
                                onSaveApproval={(id, action, data) =>
                                    void hitl.handleSaveApproval(id, action, data, activeWorkflows)
                                }
                                onRunApproval={(id, action, data) =>
                                    void hitl.handleRunApproval(id, action, data, activeWorkflows)
                                }
                                onRunSavedTest={(id, path, workflowId) =>
                                    void hitl.handleRunSavedTest(id, path, workflowId)
                                }
                                onHITLAction={(actionId, context) =>
                                    void hitl.handleHITLAction(actionId, context)
                                }
                                onFileSelect={onFileSelect}
                            />

                            <ChatComposer
                                formRef={composer.formRef}
                                inputRef={composer.inputRef}
                                inputValue={composer.inputValue}
                                isGenerating={isGenerating}
                                showSlashAutocomplete={composer.showSlashAutocomplete}
                                showAutocomplete={composer.showAutocomplete}
                                slashMatches={composer.slashMatches}
                                slashPosition={composer.slashPosition}
                                filteredFiles={composer.filteredFiles}
                                autocompletePosition={composer.autocompletePosition}
                                onSubmit={handleSubmit}
                                onInputChange={composer.handleInputChange}
                                onInputClick={composer.handleInputClick}
                                onKeyDown={(e) =>
                                    composer.handleKeyDown(e, () =>
                                        echoSystemMessage("_Stopping the agent…_"),
                                    )
                                }
                                onSelectSlash={composer.selectSlashCommand}
                                onSelectFile={composer.selectFile}
                                onSlashHover={composer.setSlashPosition}
                                onFileHover={composer.setAutocompletePosition}
                                onStop={() => {
                                    if (handleStop()) echoSystemMessage("_Stopping the agent…_");
                                }}
                            />
                        </div>
                    )}

                    {activeTab === "files" && (
                        <SidebarFilesTab
                            filesLoading={filesLoading}
                            filesRefetching={filesRefetching}
                            files={files}
                            activeFilePath={activeFilePath}
                            onFileSelect={onFileSelect}
                            onRefresh={() => void refetchTestFiles()}
                        />
                    )}
                </>
            )}
        </aside>
    );
}

export { mapServerChatMessage, mergeChatMessages } from "./chat/message-mapper";
export { checkFileMentionAutocomplete, insertFileMention } from "./composer/mention-utils";
export {
    computeHitlPending,
    deriveRunResolution,
    deriveSaveResolution,
    rehydrateWorkflowHitlCards,
} from "./hitl/workflow-state";
export { formatInterruptedAssistantMessage } from "./stream/parse-stream";
export { useAgentStream } from "./stream/use-agent-stream";
export type { HITLConfirmation, Message, SidebarProps } from "./types";
