import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
    type DashboardRoute,
    findSlashCommand,
    matchSlashCommands,
    parseSlashInput,
    type SidebarTab,
    type SlashCommand,
    type SlashContext,
} from "../utils/slash-commands";
import { trpc } from "../utils/trpc";
import { FilesPanel, type TestFileItem } from "./files-panel";
import { Logo } from "./logo";

// Matches the inline activity markers emitted by the agent
// (buildAgentEventMarker). The payload is base64-encoded JSON.
const AGENT_EVENT_MARKER = /<!--EVENT:([A-Za-z0-9+/=]+?)-->/g;

/**
 * Extract the agent's live activity trail from a streamed message and return the
 * message with the markers removed. Deduplicates consecutive identical labels so
 * repeated "Reading page" steps collapse into one line.
 */
function parseAgentActivity(raw: string): { clean: string; activity: string[] } {
    const activity: string[] = [];
    let match: RegExpExecArray | null;
    AGENT_EVENT_MARKER.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((match = AGENT_EVENT_MARKER.exec(raw)) !== null) {
        try {
            const decoded = JSON.parse(atob(match[1])) as {
                label?: string;
                detail?: string | null;
            };
            const label = decoded.detail ? `${decoded.label} ${decoded.detail}` : decoded.label;
            if (label && activity[activity.length - 1] !== label) activity.push(label);
        } catch {
            // Ignore malformed markers
        }
    }
    const clean = raw.replace(AGENT_EVENT_MARKER, "");
    return { clean, activity };
}

/**
 * Decode a captured `<!--HITL:…-->` payload. New markers are base64-encoded
 * JSON (so a generated test containing `-->` can't truncate them); older
 * persisted markers are raw JSON. Returns null on any parse failure.
 */
function decodeHitlPayload(payload: string): HITLConfirmation | null {
    let json = payload;
    if (/^[A-Za-z0-9+/=]+$/.test(payload)) {
        try {
            json = atob(payload);
        } catch {
            json = payload;
        }
    }
    try {
        return JSON.parse(json) as HITLConfirmation;
    } catch {
        return null;
    }
}

interface Message {
    id: string;
    content: string;
    timestamp: string;
    isUser: boolean;
    isLoading?: boolean;
    fileMentions?: string[];
    hitlData?: HITLConfirmation;
    /** Live "what the agent is doing" trail parsed from EVENT markers. */
    activity?: string[];
}

// How many recent messages to send as conversation context. Widened from 10 so
// the agent doesn't "forget" earlier turns mid-session.
const CONVERSATION_WINDOW = 30;

/**
 * Build the conversation history to send to the agent: the most recent
 * CONVERSATION_WINDOW messages, plus the original request anchored at the front
 * so long sessions don't lose the overall goal.
 */
function buildConversationWindow(messages: Message[]): Array<{ role: string; content: string }> {
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

// Human-in-the-loop confirmation data
interface HITLConfirmation {
    type: string;
    title: string;
    message: string;
    reasons: string[];
    options: Array<{
        id: string;
        label: string;
        description: string;
    }>;
    context: {
        url?: string;
        files?: string[];
    };
    /**
     * Discriminator for the HITL card shape. When `kind === "save_approval"`
     * the card renders a code preview + editable path instead of the simple
     * proceed/cancel layout used by goal-classification confirmations.
     */
    kind?: "save_approval";
    /** Test source code awaiting approval (only for kind === "save_approval"). */
    testCode?: string;
    /** Default file path the agent wants to save to. */
    suggestedPath?: string;
    /** Display name (without extension) for the pending test. */
    testName?: string;
}

// localStorage key for persisting resolved save-approval cards across reloads.
const SAVED_APPROVALS_KEY = "raiken:savedApprovals";

const WELCOME_MESSAGE: Message = {
    id: "welcome",
    content:
        "`raiken/agent` is ready.\n\nDescribe a test in plain english and I will draft it. Use `@` to attach files, or `/` to run a command.\n\nExamples:\n- `Generate a test for the LoginForm component`\n- `Write tests for the @src/utils.ts file`\n- `/discovery https://example.com` — crawl a site\n- `/doctor` — scan test suite for anti-patterns\n- `/help` — list every slash command",
    timestamp: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    isUser: false,
};

interface SidebarProps {
    onSendMessage?: (message: string) => void;
    onFileSelect?: (filePath: string) => void;
    activeFilePath?: string;
    activeTab?: "chat" | "files";
    collapsed?: boolean;
    onTabChange?: (tab: "chat" | "files") => void;
    initialPrompt?: string;
    onInitialPromptConsumed?: () => void;
    /**
     * Called by slash commands like `/discovery`, `/doctor`, `/settings` etc.
     * The sidebar only knows intent — the shell decides how to actually route.
     */
    onNavigateRoute?: (route: DashboardRoute) => void;
}

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
}: SidebarProps) {
    const activeTab = externalTab ?? "chat";
    const isCollapsed = externalCollapsed ?? false;
    const trpcUtils = trpc.useUtils();
    const [inputValue, setInputValue] = useState(initialPrompt ?? "");
    const [isGenerating, setIsGenerating] = useState(false);
    const [_streamedContent, setStreamedContent] = useState("");
    const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
    const [messagesLoaded, setMessagesLoaded] = useState(false);
    const [files, setFiles] = useState<TestFileItem[]>([]);
    const [sourceFiles, setSourceFiles] = useState<Array<{ path: string; name: string }>>([]);
    const [showAutocomplete, setShowAutocomplete] = useState(false);
    const [autocompletePosition, setAutocompletePosition] = useState(0);
    const [filteredFiles, setFilteredFiles] = useState<Array<{ path: string; name: string }>>([]);
    const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);
    const [showSlashAutocomplete, setShowSlashAutocomplete] = useState(false);
    const [slashPosition, setSlashPosition] = useState(0);
    const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const messagesRef = useRef<HTMLDivElement>(null);
    // Controls the in-flight /api/generate-test SSE fetch so the user can
    // interrupt a running agent (Stop button, Esc, or /stop).
    const abortControllerRef = useRef<AbortController | null>(null);

    // Whether the message list is scrolled (roughly) to the bottom. When the
    // user scrolls up to read history we stop auto-pinning to the bottom and
    // reveal a "scroll to bottom" button instead.
    const [isNearBottom, setIsNearBottom] = useState(true);
    const NEAR_BOTTOM_THRESHOLD = 80;

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

    // Keep the newest message in view as content streams in, but only while the
    // user is already near the bottom — otherwise we'd yank them away from
    // history they scrolled up to read.
    useEffect(() => {
        if (!isNearBottom) return;
        const el = messagesRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, isNearBottom]);

    // Grow the input vertically as the user types a long message instead of
    // scrolling it sideways. Runs on every value change (typed, slash/file
    // autocomplete insertions, prompt seeding, and reset after submit).
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [inputValue]);

    useEffect(() => {
        if (initialPrompt) {
            setInputValue(initialPrompt);
            onInitialPromptConsumed?.();
            setPendingAutoSubmit(true);
        }
    }, [initialPrompt]);

    useEffect(() => {
        if (pendingAutoSubmit && inputValue && !isGenerating) {
            setPendingAutoSubmit(false);
            const timer = setTimeout(() => {
                formRef.current?.requestSubmit();
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [pendingAutoSubmit, inputValue, isGenerating]);

    // Load persisted chat messages
    const { data: chatData } = trpc.getChatMessages.useQuery(undefined, {
        refetchOnWindowFocus: false,
    });

    // Mutation to save messages
    const addMessageMutation = trpc.addChatMessage.useMutation();
    const clearMessagesMutation = trpc.clearChatMessages.useMutation();

    // Mutations for the save-approval HITL flow. We invoke these directly
    // from the dashboard so approving a save doesn't have to round-trip
    // through the LLM (which would re-classify "approve" as a new prompt
    // and risk losing the test draft entirely).
    const saveTestMutation = trpc.saveGeneratedTest.useMutation();
    const updateConfigMutation = trpc.updateConfig.useMutation();
    const runTestMutation = trpc.runTests.useMutation();
    // Read once so the auto-open heuristic below can tell whether the AGENT
    // already persisted the spec (autoSaveTests). Without this, an auto-saved
    // spec that is also streamed back would get saved a SECOND time here,
    // producing a duplicate file when our derived name differs from the
    // agent's chosen path.
    const { data: raikenConfig } = trpc.getConfig.useQuery();

    // Which saved-approval card is currently running its test (keyed by msg id).
    const [runningTestFor, setRunningTestFor] = useState<string | null>(null);

    /**
     * Track save-approval cards that have already resolved (either saved
     * or rejected) so we can disable their buttons and show the outcome
     * inline. Keyed by the message id of the HITL card.
     */
    const [savedApprovals, setSavedApprovals] = useState<
        Record<string, { status: "saved" | "rejected"; filePath?: string; error?: string }>
    >(() => {
        // Hydrate from localStorage so a resolved save/reject stays resolved
        // across reloads — otherwise the persisted HITL card would re-render
        // with its buttons enabled and the user could save/reject twice.
        try {
            const raw = localStorage.getItem(SAVED_APPROVALS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    });

    /** Per-card override of the suggested path while the user edits it. */
    const [pathEdits, setPathEdits] = useState<Record<string, string>>({});

    // Persist resolved approvals so they survive reloads.
    useEffect(() => {
        try {
            localStorage.setItem(SAVED_APPROVALS_KEY, JSON.stringify(savedApprovals));
        } catch {
            // localStorage unavailable — non-critical.
        }
    }, [savedApprovals]);

    // Load messages from server on mount
    useEffect(() => {
        if (chatData?.messages && !messagesLoaded) {
            if (chatData.messages.length > 0) {
                // Convert server messages to local format. Persisted assistant
                // messages may contain a `<!--HITL:..-->` marker (we store the
                // raw `accumulated` string at stream-end time, not the
                // post-strip display content). Re-parse it here so the
                // approval card re-renders after a reload — otherwise the
                // user comes back to a chat with the buttons gone and the
                // raw HTML comment string sitting in the transcript.
                const loadedMessages: Message[] = chatData.messages.map((msg) => {
                    const baseMessage: Message = {
                        id: msg.id,
                        content: msg.content,
                        timestamp: new Date(msg.timestamp).toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                        isUser: msg.sender === "user",
                        fileMentions: msg.fileMentions,
                    };
                    if (!msg.content || msg.sender === "user") return baseMessage;
                    const hitlMatch = msg.content.match(/<!--HITL:([\s\S]+?)-->/);
                    if (!hitlMatch) return baseMessage;
                    const hitlData = decodeHitlPayload(hitlMatch[1]);
                    if (!hitlData) return baseMessage;
                    return {
                        ...baseMessage,
                        content: msg.content.replace(/<!--HITL:[\s\S]+?-->/, "").trim(),
                        hitlData,
                    };
                });
                setMessages([WELCOME_MESSAGE, ...loadedMessages]);
            }
            setMessagesLoaded(true);
        }
    }, [chatData, messagesLoaded]);

    // Helper to persist a message to the server
    const persistMessage = (message: Message) => {
        addMessageMutation.mutate({
            id: message.id,
            content: message.content,
            sender: message.isUser ? "user" : "assistant",
            timestamp: Date.now(),
            fileMentions: message.fileMentions,
        });
    };

    // Clear chat handler
    const handleClearChat = () => {
        clearMessagesMutation.mutate(undefined, {
            onSuccess: () => {
                setMessages([WELCOME_MESSAGE]);
                // Drop resolved-approval bookkeeping too so a fresh chat starts clean.
                setSavedApprovals({});
                setPathEdits({});
            },
        });
    };

    // Handle HITL (Human-in-the-Loop) button clicks
    const handleHITLAction = async (
        actionId: string,
        context: { url?: string; files?: string[] },
    ) => {
        // Send a special message that the backend will recognize
        const hitlMessage = `HITL_ACTION:${actionId}:${JSON.stringify(context)}`;

        // Add user action as a message
        const actionLabel =
            actionId === "proceed" ? "✅ Proceed with test generation" : "❌ Cancel";
        const userMessage: Message = {
            id: Date.now().toString(),
            content: actionLabel,
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: true,
        };

        setMessages((prev) => [...prev, userMessage]);
        setIsGenerating(true);

        // Add AI placeholder
        const aiMessageId = (Date.now() + 1).toString();
        const aiMessage: Message = {
            id: aiMessageId,
            content: "",
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: false,
            isLoading: true,
        };
        setMessages((prev) => [...prev, aiMessage]);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const response = await fetch("/api/generate-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    prompt: hitlMessage,
                    fileContext: context.files || [],
                    conversationHistory: buildConversationWindow(messages),
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to process action");
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let accumulated = "";

            if (!reader) {
                throw new Error("No response body");
            }

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split("\n");

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.chunk) {
                                accumulated += data.chunk;
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === aiMessageId
                                            ? { ...msg, content: accumulated, isLoading: false }
                                            : msg,
                                    ),
                                );
                            }
                        } catch {
                            // Ignore parse errors
                        }
                    }
                }
            }

            // Check if we should trigger save dialog
            const hasPlaywrightImport =
                accumulated.includes("import { test") && accumulated.includes("@playwright/test");
            const hasTestStructure =
                accumulated.includes("test.describe(") ||
                (accumulated.includes("describe(") && accumulated.includes("test("));
            const hasMultipleTests = (accumulated.match(/\btest\s*\(/g) || []).length >= 2;

            if (hasPlaywrightImport && hasTestStructure && hasMultipleTests) {
                onSendMessage?.(accumulated);
            }

            // Persist the AI response
            persistMessage({
                id: aiMessageId,
                content: accumulated,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            });
        } catch (error) {
            const stopped = error instanceof DOMException && error.name === "AbortError";
            if (!stopped) console.error("HITL action failed:", error);
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.id === aiMessageId
                        ? {
                              ...msg,
                              content: stopped
                                  ? "_Stopped._"
                                  : `Error: ${error instanceof Error ? error.message : "Action failed"}`,
                              isLoading: false,
                          }
                        : msg,
                ),
            );
        } finally {
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    /**
     * Handle the rich save-approval card (kind === "save_approval").
     *
     * Unlike `handleHITLAction` which round-trips back through the LLM via
     * /api/generate-test, save approval is fully deterministic: the user
     * either approves a known {testCode, suggestedPath} pair, edits the
     * path, or rejects it. We call `saveGeneratedTest` directly so the
     * outcome is immediate and the LLM is never given a chance to "lose"
     * the draft.
     */
    const handleSaveApproval = async (
        messageId: string,
        actionId: "save_approve" | "save_approve_remember" | "save_reject",
        hitl: HITLConfirmation,
    ) => {
        if (savedApprovals[messageId]) return;

        if (actionId === "save_reject") {
            setSavedApprovals((prev) => ({ ...prev, [messageId]: { status: "rejected" } }));
            const rejectMessage: Message = {
                id: `sys-${Date.now()}`,
                content: "❌ Rejected. The draft was discarded.",
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, rejectMessage]);
            persistMessage(rejectMessage);
            return;
        }

        const requestedPath = (pathEdits[messageId] ?? hitl.suggestedPath ?? "").trim();
        const testCode = hitl.testCode ?? "";
        if (!requestedPath || !testCode) {
            setSavedApprovals((prev) => ({
                ...prev,
                [messageId]: {
                    status: "rejected",
                    error: "Missing path or test content — cannot save.",
                },
            }));
            return;
        }

        // Split "<dir>/<file>" so saveGeneratedTest's strict filename
        // validator is happy (it requires *.spec.ts | *.test.tsx etc and
        // forbids slashes in fileName).
        const lastSlash = requestedPath.lastIndexOf("/");
        const testDir = lastSlash >= 0 ? requestedPath.slice(0, lastSlash) : "e2e";
        const fileName = lastSlash >= 0 ? requestedPath.slice(lastSlash + 1) : requestedPath;

        try {
            const result = await saveTestMutation.mutateAsync({
                fileName,
                content: testCode,
                testDir,
                // The path is auto-suggested (or lightly edited) — never silently
                // clobber a different existing spec; dedup to a unique name.
                avoidOverwrite: true,
            });

            if (actionId === "save_approve_remember") {
                try {
                    await updateConfigMutation.mutateAsync({
                        config: { autonomy: { autoSaveTests: true } },
                    });
                } catch (err) {
                    console.warn("Failed to persist autoSaveTests preference:", err);
                }
            }

            setSavedApprovals((prev) => ({
                ...prev,
                [messageId]: { status: "saved", filePath: result.filePath },
            }));

            const confirmMsg: Message = {
                id: `sys-${Date.now()}`,
                content:
                    actionId === "save_approve_remember"
                        ? `✅ Saved \`${result.filePath}\`. Future tests will save automatically.`
                        : `✅ Saved \`${result.filePath}\`.`,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, confirmMsg]);
            persistMessage(confirmMsg);

            // Refresh the file list so the new spec shows up in the Files panel.
            refetchTestFiles();

            // Open the freshly saved test in the editor so the user lands on it.
            if (result.filePath) {
                onFileSelect?.(result.filePath);
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Save failed";
            console.error("Save approval failed:", err);
            setSavedApprovals((prev) => ({
                ...prev,
                [messageId]: { status: "rejected", error: errorMessage },
            }));
            const errMsg: Message = {
                id: `sys-${Date.now()}`,
                content: `⚠️ Could not save: ${errorMessage}`,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, errMsg]);
        }
    };

    /**
     * Run a test that was just saved from a save-approval card. This closes the
     * generate → save → run loop directly in chat (the graph itself ends at the
     * save pause, so running is offered here deterministically via tRPC rather
     * than resuming the LLM). Results are summarized inline; on failure we point
     * the user to the editor where "Fix with AI" lives.
     */
    const handleRunSavedTest = async (messageId: string, filePath: string) => {
        if (runningTestFor) return;
        setRunningTestFor(messageId);
        const runningMsg: Message = {
            id: `sys-run-${Date.now()}`,
            content: `▶️ Running \`${filePath}\`…`,
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: false,
        };
        setMessages((prev) => [...prev, runningMsg]);

        try {
            const result = (await runTestMutation.mutateAsync({ testFile: filePath })) as {
                success?: boolean;
            };
            const passed = Boolean(result.success);
            const summary = passed
                ? `✅ \`${filePath}\` passed.`
                : `❌ \`${filePath}\` failed. Open it in the editor and use **Fix with AI** to repair the spec.`;
            const resultMsg: Message = {
                id: `sys-run-done-${Date.now()}`,
                content: summary,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, resultMsg]);
            persistMessage(resultMsg);
            if (!passed) onFileSelect?.(filePath);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Test run failed";
            const errMsg: Message = {
                id: `sys-run-err-${Date.now()}`,
                content: `⚠️ Could not run test: ${errorMessage}`,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            setMessages((prev) => [...prev, errMsg]);
        } finally {
            setRunningTestFor(null);
        }
    };

    // Fetch test files from filesystem (not from code graph)
    const {
        data: testFilesData,
        isLoading: filesLoading,
        isFetching: filesRefetching,
        refetch: refetchTestFiles,
    } = trpc.listTestFiles.useQuery({});

    // Fetch ALL files for @ mentions (including both source and test files)
    const { data: allFilesData } = trpc.getGraphFiles.useQuery({
        limit: 1000,
        offset: 0,
    });

    // Convert API files to TestFileItem format (for the Files panel)
    useEffect(() => {
        if (testFilesData?.files) {
            const convertedFiles: TestFileItem[] = testFilesData.files.map((file, index) => ({
                id: `test-${index}`,
                name: file.name,
                path: file.path,
                directory: file.directory,
            }));

            setFiles(convertedFiles);
        }
    }, [testFilesData]);

    // Process all files for @ mentions (include ALL files - both source and test files)
    useEffect(() => {
        if (allFilesData?.files && testFilesData?.files) {
            // Combine source files from code graph
            const sourceFilesFromGraph = allFilesData.files.map((file) => ({
                path: file.path,
                name: file.path.split("/").pop() || file.path,
            }));

            // Add test files from filesystem
            const testFilesForAutocomplete = testFilesData.files.map((file) => ({
                path: file.path,
                name: file.name,
            }));

            // Combine and deduplicate
            const allFiles = [...sourceFilesFromGraph, ...testFilesForAutocomplete];
            const uniqueFiles = Array.from(new Map(allFiles.map((f) => [f.path, f])).values());

            setSourceFiles(uniqueFiles);
        }
    }, [allFilesData, testFilesData]);

    const checkAndShowSlashAutocomplete = (value: string) => {
        // Only match when the entire input is a slash expression and we haven't
        // moved past the command token (first whitespace ends the match window).
        const trimmed = value.trimStart();
        if (!trimmed.startsWith("/")) {
            setShowSlashAutocomplete(false);
            return false;
        }
        const body = trimmed.slice(1);
        const firstSpace = body.search(/\s/);
        if (firstSpace !== -1) {
            // Past the command token — args are being typed. Keep panel closed.
            setShowSlashAutocomplete(false);
            return true;
        }
        const matches = matchSlashCommands(body);
        setSlashMatches(matches);
        setShowSlashAutocomplete(matches.length > 0);
        setSlashPosition(0);
        return true;
    };

    const checkAndShowAutocomplete = (value: string, cursorPos: number) => {
        // Slash commands take precedence while typing a command token.
        if (checkAndShowSlashAutocomplete(value)) {
            setShowAutocomplete(false);
            return;
        }
        const textBeforeCursor = value.slice(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf("@");

        if (lastAtIndex !== -1) {
            const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
            const hasSpaceAfterAt = afterAt.includes(" ");

            if (!hasSpaceAfterAt && cursorPos - lastAtIndex <= 50) {
                if (sourceFiles.length === 0) {
                    return;
                }

                if (lastAtIndex === cursorPos - 1) {
                    setFilteredFiles(sourceFiles);
                    setShowAutocomplete(true);
                    setAutocompletePosition(0);
                } else {
                    const searchTerm = afterAt;
                    const filtered = sourceFiles.filter(
                        (file) =>
                            file.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            file.path.toLowerCase().includes(searchTerm.toLowerCase()),
                    );
                    setFilteredFiles(filtered);
                    setShowAutocomplete(filtered.length > 0);
                    setAutocompletePosition(0);
                }
            } else {
                setShowAutocomplete(false);
            }
        } else {
            setShowAutocomplete(false);
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setInputValue(value);
        const cursorPos = e.target.selectionStart || 0;
        checkAndShowAutocomplete(value, cursorPos);
    };

    const handleInputClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        const cursorPos = (e.target as HTMLTextAreaElement).selectionStart || 0;
        checkAndShowAutocomplete(inputValue, cursorPos);
    };

    // Copy code to clipboard
    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    // Open code in editor as a new file
    const openCodeInEditor = (code: string, language: string) => {
        // Generate a temp file name based on language
        const ext =
            language === "typescript" || language === "ts"
                ? "ts"
                : language === "javascript" || language === "js"
                  ? "js"
                  : language === "tsx"
                    ? "tsx"
                    : language === "jsx"
                      ? "jsx"
                      : language === "python"
                        ? "py"
                        : language === "css"
                          ? "css"
                          : language === "html"
                            ? "html"
                            : "txt";
        const fileName = `scratch-${Date.now()}.${ext}`;
        // Store the code temporarily and open in editor
        sessionStorage.setItem(`scratch:${fileName}`, code);
        onFileSelect?.(`scratch:${fileName}`);
    };

    /**
     * Open a pending save-approval draft in the editor for review before the
     * user commits to saving it. We open it as a scratch buffer named after the
     * suggested path so the tab reads sensibly (e.g. `login.spec.ts`) without
     * writing anything to disk — Save / Reject still live on the card.
     */
    const openHitlTestInEditor = (hitl: HITLConfirmation) => {
        const code = hitl.testCode ?? "";
        if (!code) return;
        const rawName =
            hitl.testName ||
            hitl.suggestedPath?.split("/").pop() ||
            `raiken-test-${Date.now()}.spec.ts`;
        let safeName = rawName.replace(/[^\w.-]/g, "-");
        if (!/\.(ts|tsx|js|jsx)$/.test(safeName)) {
            safeName = `${safeName}.spec.ts`;
        }
        const scratchName = `scratch:${safeName}`;
        sessionStorage.setItem(scratchName, code);
        onFileSelect?.(scratchName);
    };

    // Render message content with markdown support and @ mentions styled
    const renderMessageContent = (content: string, isUser = false) => {
        // For user messages, just style the @ mentions
        if (isUser) {
            const mentionRegex = /@([\w/.-]+)/g;
            const parts: React.ReactNode[] = [];
            let lastIndex = 0;
            let match;

            while ((match = mentionRegex.exec(content)) !== null) {
                if (match.index > lastIndex) {
                    parts.push(content.substring(lastIndex, match.index));
                }
                parts.push(
                    <span key={match.index} className="file-mention">
                        @{match[1]}
                    </span>,
                );
                lastIndex = match.index + match[0].length;
            }

            if (lastIndex < content.length) {
                parts.push(content.substring(lastIndex));
            }

            return parts.length > 0 ? parts : content;
        }

        // For assistant messages, render as Markdown
        return (
            <Markdown
                components={{
                    // Style code blocks
                    code: ({ className, children, ...props }) => {
                        const isInline = !className;
                        return isInline ? (
                            <code className="inline-code" {...props}>
                                {children}
                            </code>
                        ) : (
                            <code className={`code-block ${className || ""}`} {...props}>
                                {children}
                            </code>
                        );
                    },
                    // Style pre blocks with copy/open buttons
                    pre: ({ children }: { children?: React.ReactNode }) => {
                        const codeElement = children as React.ReactElement<{ className?: string }>;
                        const langClass = codeElement?.props?.className || "";
                        const language = langClass
                            .replace("language-", "")
                            .replace("code-block ", "");
                        const [copied, setCopied] = useState(false);
                        const preRef = useRef<HTMLPreElement>(null);

                        const getCodeContent = () => preRef.current?.textContent || "";

                        const handleCopy = () => {
                            copyToClipboard(getCodeContent());
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                        };

                        return (
                            <div className="code-block-wrapper">
                                <div className="code-block-header">
                                    <span className="code-lang">{language || "code"}</span>
                                    <div className="code-block-actions">
                                        <button
                                            type="button"
                                            className="code-action-btn"
                                            onClick={handleCopy}
                                            title="Copy code"
                                        >
                                            {copied ? (
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <path d="M5 13l4 4L19 7" />
                                                </svg>
                                            ) : (
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                >
                                                    <rect
                                                        x="9"
                                                        y="9"
                                                        width="13"
                                                        height="13"
                                                        rx="2"
                                                        ry="2"
                                                    />
                                                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                                                </svg>
                                            )}
                                        </button>
                                        <button
                                            type="button"
                                            className="code-action-btn"
                                            onClick={() =>
                                                openCodeInEditor(getCodeContent(), language)
                                            }
                                            title="Open in editor"
                                        >
                                            <svg
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2"
                                            >
                                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                                                <polyline points="15 3 21 3 21 9" />
                                                <line x1="10" y1="14" x2="21" y2="3" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                                <pre ref={preRef} className="code-pre">
                                    {children}
                                </pre>
                            </div>
                        );
                    },
                    // Style links
                    a: ({ href, children }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="md-link"
                        >
                            {children}
                        </a>
                    ),
                    // Style lists
                    ul: ({ children }) => <ul className="md-list">{children}</ul>,
                    ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
                    li: ({ children }) => <li className="md-list-item">{children}</li>,
                    // Style headings
                    h1: ({ children }) => <h1 className="md-heading md-h1">{children}</h1>,
                    h2: ({ children }) => <h2 className="md-heading md-h2">{children}</h2>,
                    h3: ({ children }) => <h3 className="md-heading md-h3">{children}</h3>,
                    // Style blockquotes
                    blockquote: ({ children }) => (
                        <blockquote className="md-blockquote">{children}</blockquote>
                    ),
                    // Style tables
                    table: ({ children }) => <table className="md-table">{children}</table>,
                    th: ({ children }) => <th className="md-th">{children}</th>,
                    td: ({ children }) => <td className="md-td">{children}</td>,
                }}
            >
                {content}
            </Markdown>
        );
    };

    const selectFile = (
        file: { path: string; name: string },
        event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
        // Prevent any default behavior that might trigger form submission
        event?.preventDefault();
        event?.stopPropagation();

        const cursorPos = inputRef.current?.selectionStart || 0;
        const textBeforeCursor = inputValue.slice(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf("@");

        if (lastAtIndex !== -1) {
            const beforeAt = inputValue.slice(0, lastAtIndex);
            const afterCursor = inputValue.slice(cursorPos);
            const newValue = `${beforeAt}@${file.path} ${afterCursor}`;
            setInputValue(newValue);
            setShowAutocomplete(false);

            // Set focus back to input with a slight delay to ensure autocomplete closes first
            setTimeout(() => {
                inputRef.current?.focus();
                // Position cursor after the inserted file path
                const newCursorPos = lastAtIndex + file.path.length + 2; // +2 for @ and space
                inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
            }, 10);
        }
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Slash autocomplete has priority when active.
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
            if (e.key === "Escape") {
                setShowSlashAutocomplete(false);
                return;
            }
            // Enter falls through to the submit handler below, which parses the
            // slash input.
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
                // When autocomplete is showing, Enter selects from autocomplete,
                // NOT submit the form.
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

        // Esc interrupts a running agent (when no autocomplete popup is open,
        // which is handled above).
        if (e.key === "Escape" && isGenerating) {
            e.preventDefault();
            if (handleStop()) {
                echoSystemMessage("_Stopping the agent…_");
            }
            return;
        }

        // A textarea inserts a newline on Enter instead of submitting like an
        // <input> would, so submit explicitly. Shift+Enter keeps the newline so
        // users can compose multi-line messages.
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            formRef.current?.requestSubmit();
        }
    };

    const echoSystemMessage = (markdown: string) => {
        if (!markdown) return;
        const id = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const message: Message = {
            id,
            content: markdown,
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: false,
        };
        setMessages((prev) => [...prev, message]);
        persistMessage(message);
    };

    /**
     * Interrupt the running agent by aborting the in-flight SSE fetch. Aborting
     * the request closes the connection, which the server observes and uses to
     * cancel the underlying LangGraph run. Returns whether anything was stopped.
     */
    const handleStop = (): boolean => {
        const controller = abortControllerRef.current;
        if (!controller) return false;
        controller.abort();
        abortControllerRef.current = null;
        return true;
    };

    const executeSlashCommand = async (raw: string): Promise<boolean> => {
        const parsed = parseSlashInput(raw);
        if (!parsed) return false;
        const cmd = findSlashCommand(parsed.name);

        // Always echo the invocation so the transcript has a record of what ran.
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
            setSidebarTab: (tab) => onTabChange?.(tab as SidebarTab),
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

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!inputValue.trim()) return;

        // Intercept slash commands before hitting the AI. Stop-family commands
        // are allowed through even while generating so the user can interrupt a
        // running agent by typing `/stop`; every other command is blocked while
        // busy to avoid launching a second concurrent run.
        if (inputValue.trimStart().startsWith("/")) {
            const parsed = parseSlashInput(inputValue);
            const isStopCommand = !!parsed && ["stop", "abort", "cancel"].includes(parsed.name);
            if (isGenerating && !isStopCommand) return;
            const raw = inputValue;
            setInputValue("");
            setShowSlashAutocomplete(false);
            await executeSlashCommand(raw);
            return;
        }

        if (isGenerating) return;

        // Extract mentioned files from current prompt
        const mentionRegex = /@([^\s]+)/g;
        const matches = [...inputValue.matchAll(mentionRegex)];
        const newFileContext = matches.map((match) => match[1]);

        // Build conversation history (recent window + anchored original request)
        const conversationHistory = buildConversationWindow(messages);

        // Extract all files mentioned in conversation history
        const historicalFiles = new Set<string>();
        messages.forEach((msg) => {
            const msgMatches = [...msg.content.matchAll(mentionRegex)];
            msgMatches.forEach((match) => historicalFiles.add(match[1]));
        });

        // Combine new files with historical files (deduplicate)
        const allFileContext = [...new Set([...newFileContext, ...Array.from(historicalFiles)])];

        const userMessage: Message = {
            id: Date.now().toString(),
            content: inputValue,
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: true,
            fileMentions: newFileContext.length > 0 ? newFileContext : undefined,
        };

        setMessages((prev) => [...prev, userMessage]);
        persistMessage(userMessage); // Save to server
        const prompt = inputValue;
        setInputValue("");
        setIsGenerating(true);
        setStreamedContent("");

        // Add AI placeholder message with loading state
        const aiMessageId = (Date.now() + 1).toString();
        const aiMessage: Message = {
            id: aiMessageId,
            content: "",
            timestamp: new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            }),
            isUser: false,
            isLoading: true,
        };
        setMessages((prev) => [...prev, aiMessage]);

        const controller = new AbortController();
        abortControllerRef.current = controller;
        // Hoisted so the catch block can append what streamed so far when the
        // run is stopped mid-flight.
        let accumulated = "";

        try {
            const response = await fetch("/api/generate-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    prompt,
                    fileContext: allFileContext, // Send all mentioned files
                    conversationHistory, // Send conversation history for context
                    // When a real (non-scratch) test file is highlighted, target
                    // it so a newly generated test overwrites that file.
                    targetTestFile:
                        activeFilePath && !activeFilePath.startsWith("scratch:")
                            ? activeFilePath
                            : undefined,
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to generate test");
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();

            if (!reader) {
                throw new Error("No response body");
            }

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split("\n");

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        // Parse the SSE JSON separately from handling it: a
                        // JSON.parse failure means a partial chunk we can skip,
                        // but a server-sent {error} must propagate to the outer
                        // catch instead of being swallowed as "incomplete".
                        let data: {
                            error?: string;
                            chunk?: string;
                            done?: boolean;
                        } | null = null;
                        try {
                            data = JSON.parse(line.slice(6));
                        } catch {
                            // Incomplete/partial SSE chunk — wait for more.
                            continue;
                        }

                        if (data) {
                            if (data.error) {
                                throw new Error(data.error);
                            }

                            if (data.chunk) {
                                accumulated += data.chunk;
                                setStreamedContent(accumulated);

                                // Strip the live activity trail out of the visible
                                // content and surface it separately.
                                const { clean: withoutEvents, activity } =
                                    parseAgentActivity(accumulated);

                                // Check for HITL marker
                                const hitlMatch = withoutEvents.match(/<!--HITL:([\s\S]+?)-->/);
                                let hitlData: HITLConfirmation | undefined;
                                let displayContent = withoutEvents;

                                if (hitlMatch) {
                                    const parsed = decodeHitlPayload(hitlMatch[1]);
                                    if (parsed) {
                                        hitlData = parsed;
                                        // Remove the HITL marker from display content
                                        displayContent = "";
                                    } else {
                                        console.warn("Failed to parse HITL data");
                                    }
                                }

                                // Still "loading" until real text arrives; the
                                // activity trail shows progress in the meantime.
                                const hasText = displayContent.trim().length > 0;

                                // Update AI message with accumulated content and remove loading state
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === aiMessageId
                                            ? {
                                                  ...msg,
                                                  content: displayContent,
                                                  isLoading: !hasText && !hitlData,
                                                  hitlData,
                                                  activity,
                                              }
                                            : msg,
                                    ),
                                );
                            }

                            if (data.done) {
                                // stream complete
                            }
                        }
                    }
                }
            }

            // Strip the live activity markers before persisting/analyzing — they
            // are transient UI, not part of the assistant's message or the test.
            const cleanedFinal = parseAgentActivity(accumulated).clean;

            // Persist the AI response
            const finalAiMessage: Message = {
                id: aiMessageId,
                content: cleanedFinal,
                timestamp: new Date().toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                }),
                isUser: false,
            };
            persistMessage(finalAiMessage);

            // Only notify parent if this is a complete test file (not just a snippet or confirmation prompt)
            // Must have BOTH import and test structure, and NOT be a HITL confirmation.
            const hasPlaywrightImport =
                cleanedFinal.includes("import { test") && cleanedFinal.includes("@playwright/test");
            const hasTestStructure =
                cleanedFinal.includes("test.describe(") ||
                (cleanedFinal.includes("describe(") && cleanedFinal.includes("test("));
            // A single well-formed test IS a complete file — requiring >= 2 meant
            // single-test specs were never opened/saved. The import + describe
            // structure already distinguishes a real file from a bare snippet.
            const hasTest = (cleanedFinal.match(/\btest\s*\(/g) || []).length >= 1;
            const isHITLConfirmation = cleanedFinal.includes("<!--HITL:");

            const isCompleteTestFile =
                hasPlaywrightImport && hasTestStructure && hasTest && !isHITLConfirmation;

            // When autoSaveTests is on, the agent's saveFile tool already wrote
            // the spec to disk. Re-saving here would duplicate it (and possibly
            // under a different derived name), so just refresh the file list and
            // let the agent-saved file surface instead of saving again.
            const agentAlreadySaved = Boolean(
                (raikenConfig as { autonomy?: { autoSaveTests?: boolean } } | undefined)?.autonomy
                    ?.autoSaveTests,
            );

            if (isCompleteTestFile) {
                if (agentAlreadySaved) {
                    void refetchTestFiles();
                } else {
                    onSendMessage?.(cleanedFinal);
                }
            }
        } catch (error) {
            const stopped = error instanceof DOMException && error.name === "AbortError";
            if (!stopped) console.error("Test generation failed:", error);

            // Update AI message with a stopped notice or the error.
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.id === aiMessageId
                        ? {
                              ...msg,
                              content: stopped
                                  ? accumulated
                                      ? `${accumulated}\n\n_Stopped._`
                                      : "_Stopped._"
                                  : `Error: ${error instanceof Error ? error.message : "Failed to generate test"}`,
                              isLoading: false,
                          }
                        : msg,
                ),
            );
        } finally {
            abortControllerRef.current = null;
            setIsGenerating(false);
        }
    };

    return (
        <aside className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
            {!isCollapsed && (
                <>
                    {/* Chat Panel */}
                    {activeTab === "chat" && (
                        <div className="chat-panel">
                            {/* Agent header — terminal-style status strip */}
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
                                    onClick={handleClearChat}
                                    title="clear chat history"
                                    aria-label="clear chat history"
                                    disabled={messages.length <= 1}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                    >
                                        <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </div>

                            {/* Messages */}
                            <div
                                className="messages"
                                ref={messagesRef}
                                onScroll={handleMessagesScroll}
                            >
                                {messages.map((msg) => (
                                    <div
                                        key={msg.id}
                                        className={`message ${msg.isUser ? "user" : "assistant"}`}
                                    >
                                        <div className="message-bubble">
                                            {msg.isLoading ? (
                                                <div className="agent-activity">
                                                    {msg.activity && msg.activity.length > 0 ? (
                                                        <ul className="activity-trail">
                                                            {msg.activity.map((label, i, arr) => (
                                                                <li
                                                                    key={`${msg.id}-act-${i}`}
                                                                    className={
                                                                        i === arr.length - 1
                                                                            ? "activity-current"
                                                                            : "activity-done"
                                                                    }
                                                                >
                                                                    {label}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    ) : null}
                                                    <div className="typing-indicator">
                                                        <span></span>
                                                        <span></span>
                                                        <span></span>
                                                    </div>
                                                </div>
                                            ) : msg.hitlData?.kind === "save_approval" ? (
                                                // Save-approval card: shows the actual test
                                                // code awaiting confirmation, lets the user
                                                // edit the path, and routes Approve/Reject
                                                // through `handleSaveApproval` (deterministic
                                                // — does not hit the LLM).
                                                (() => {
                                                    const hitl = msg.hitlData;
                                                    const decision = savedApprovals[msg.id];
                                                    const editedPath =
                                                        pathEdits[msg.id] ??
                                                        hitl.suggestedPath ??
                                                        "";
                                                    const isResolved = Boolean(decision);
                                                    const isSaving = saveTestMutation.isPending;
                                                    return (
                                                        <div className="hitl-confirmation hitl-save">
                                                            <div className="hitl-header">
                                                                <svg
                                                                    viewBox="0 0 24 24"
                                                                    fill="none"
                                                                    stroke="currentColor"
                                                                    strokeWidth="2"
                                                                    aria-hidden="true"
                                                                    focusable="false"
                                                                >
                                                                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                                                                    <path d="M17 21v-8H7v8M7 3v5h8" />
                                                                </svg>
                                                                <span>{hitl.title}</span>
                                                            </div>
                                                            <p className="hitl-message">
                                                                {hitl.message}
                                                            </p>

                                                            {hitl.testCode && (
                                                                <div className="hitl-code-preview">
                                                                    <div className="hitl-code-header">
                                                                        <span>
                                                                            {hitl.testName ??
                                                                                "test"}
                                                                        </span>
                                                                        <span className="hitl-code-meta">
                                                                            {
                                                                                hitl.testCode.split(
                                                                                    "\n",
                                                                                ).length
                                                                            }{" "}
                                                                            lines
                                                                        </span>
                                                                    </div>
                                                                    <pre>
                                                                        <code>{hitl.testCode}</code>
                                                                    </pre>
                                                                </div>
                                                            )}

                                                            <label
                                                                className="hitl-path-row"
                                                                htmlFor={`hitl-path-${msg.id}`}
                                                            >
                                                                <span>Save to</span>
                                                                <input
                                                                    id={`hitl-path-${msg.id}`}
                                                                    className="hitl-path-input"
                                                                    type="text"
                                                                    value={editedPath}
                                                                    onChange={(e) =>
                                                                        setPathEdits((prev) => ({
                                                                            ...prev,
                                                                            [msg.id]:
                                                                                e.target.value,
                                                                        }))
                                                                    }
                                                                    disabled={
                                                                        isResolved || isSaving
                                                                    }
                                                                />
                                                            </label>

                                                            <div className="hitl-actions">
                                                                {hitl.testCode && (
                                                                    <button
                                                                        type="button"
                                                                        className="hitl-btn ghost"
                                                                        onClick={() =>
                                                                            openHitlTestInEditor(
                                                                                hitl,
                                                                            )
                                                                        }
                                                                        disabled={isSaving}
                                                                        title="Open the generated test in the editor to review it"
                                                                    >
                                                                        <span>Open in editor</span>
                                                                    </button>
                                                                )}
                                                                {hitl.options.map((option) => {
                                                                    const variant =
                                                                        option.id === "save_approve"
                                                                            ? "primary"
                                                                            : option.id ===
                                                                                "save_reject"
                                                                              ? "danger"
                                                                              : "secondary";
                                                                    return (
                                                                        <button
                                                                            key={option.id}
                                                                            type="button"
                                                                            className={`hitl-btn ${variant}`}
                                                                            onClick={() =>
                                                                                handleSaveApproval(
                                                                                    msg.id,
                                                                                    option.id as
                                                                                        | "save_approve"
                                                                                        | "save_approve_remember"
                                                                                        | "save_reject",
                                                                                    hitl,
                                                                                )
                                                                            }
                                                                            disabled={
                                                                                isResolved ||
                                                                                isSaving
                                                                            }
                                                                            title={
                                                                                option.description
                                                                            }
                                                                        >
                                                                            <span>
                                                                                {option.label}
                                                                            </span>
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>

                                                            {decision?.status === "saved" && (
                                                                <div className="hitl-resolved hitl-resolved-ok">
                                                                    <p>
                                                                        ✅ Saved to{" "}
                                                                        <code>
                                                                            {decision.filePath}
                                                                        </code>
                                                                        .
                                                                    </p>
                                                                    {decision.filePath && (
                                                                        <div className="hitl-actions">
                                                                            <button
                                                                                type="button"
                                                                                className="hitl-btn secondary"
                                                                                onClick={() =>
                                                                                    onFileSelect?.(
                                                                                        decision.filePath as string,
                                                                                    )
                                                                                }
                                                                                disabled={Boolean(
                                                                                    runningTestFor,
                                                                                )}
                                                                                title="Open the saved test in the editor"
                                                                            >
                                                                                <span>
                                                                                    Open in editor
                                                                                </span>
                                                                            </button>
                                                                            <button
                                                                                type="button"
                                                                                className="hitl-btn primary"
                                                                                onClick={() =>
                                                                                    handleRunSavedTest(
                                                                                        msg.id,
                                                                                        decision.filePath as string,
                                                                                    )
                                                                                }
                                                                                disabled={Boolean(
                                                                                    runningTestFor,
                                                                                )}
                                                                                title="Run this test now"
                                                                            >
                                                                                <span>
                                                                                    {runningTestFor ===
                                                                                    msg.id
                                                                                        ? "Running…"
                                                                                        : "Run test"}
                                                                                </span>
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                            {decision?.status === "rejected" && (
                                                                <p className="hitl-resolved hitl-resolved-warn">
                                                                    {decision.error
                                                                        ? `⚠️ ${decision.error}`
                                                                        : "❌ Rejected — draft discarded."}
                                                                </p>
                                                            )}
                                                        </div>
                                                    );
                                                })()
                                            ) : msg.hitlData ? (
                                                // Legacy proceed/cancel goal-classification card.
                                                <div className="hitl-confirmation">
                                                    <div className="hitl-header">
                                                        <svg
                                                            viewBox="0 0 24 24"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            strokeWidth="2"
                                                        >
                                                            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                                        </svg>
                                                        <span>{msg.hitlData.title}</span>
                                                    </div>
                                                    <p className="hitl-message">
                                                        {msg.hitlData.message}
                                                    </p>
                                                    {msg.hitlData.reasons.length > 0 && (
                                                        <ul className="hitl-reasons">
                                                            {msg.hitlData.reasons.map(
                                                                (reason, i) => (
                                                                    <li key={i}>{reason}</li>
                                                                ),
                                                            )}
                                                        </ul>
                                                    )}
                                                    <div className="hitl-actions">
                                                        {msg.hitlData.options.map((option) => (
                                                            <button
                                                                key={option.id}
                                                                className={`hitl-btn ${option.id === "proceed" ? "primary" : "secondary"}`}
                                                                onClick={() =>
                                                                    handleHITLAction(
                                                                        option.id,
                                                                        msg.hitlData?.context ?? {},
                                                                    )
                                                                }
                                                                disabled={isGenerating}
                                                            >
                                                                {option.id === "proceed" ? (
                                                                    <svg
                                                                        viewBox="0 0 24 24"
                                                                        fill="none"
                                                                        stroke="currentColor"
                                                                        strokeWidth="2"
                                                                    >
                                                                        <path d="M5 13l4 4L19 7" />
                                                                    </svg>
                                                                ) : (
                                                                    <svg
                                                                        viewBox="0 0 24 24"
                                                                        fill="none"
                                                                        stroke="currentColor"
                                                                        strokeWidth="2"
                                                                    >
                                                                        <path d="M6 18L18 6M6 6l12 12" />
                                                                    </svg>
                                                                )}
                                                                <span>{option.label}</span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <p className="hitl-hint">
                                                        {
                                                            msg.hitlData.options.find(
                                                                (o) => o.id === "proceed",
                                                            )?.description
                                                        }
                                                    </p>
                                                </div>
                                            ) : (
                                                renderMessageContent(msg.content, msg.isUser)
                                            )}
                                        </div>
                                        <span className="message-time">{msg.timestamp}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Scroll-to-bottom button — only shown when the
                                user has scrolled up away from the latest message. */}
                            {!isNearBottom && (
                                <button
                                    type="button"
                                    className="scroll-to-bottom"
                                    onClick={scrollMessagesToBottom}
                                    aria-label="Scroll to latest message"
                                    title="Scroll to latest message"
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        aria-hidden="true"
                                        focusable="false"
                                    >
                                        <path d="M12 5v14M19 12l-7 7-7-7" />
                                    </svg>
                                </button>
                            )}

                            {/* Input */}
                            <form
                                ref={formRef}
                                className="chat-input-container"
                                onSubmit={handleSubmit}
                            >
                                {/* Slash Command Autocomplete */}
                                {showSlashAutocomplete && (
                                    <div className="autocomplete-dropdown slash-dropdown">
                                        <div className="slash-dropdown-head">
                                            <span>slash commands</span>
                                            <span className="slash-dropdown-hint">
                                                ↑↓ navigate · tab to pick · enter to run
                                            </span>
                                        </div>
                                        {slashMatches.map((cmd, index) => (
                                            <button
                                                key={cmd.name}
                                                type="button"
                                                className={`autocomplete-item slash-item ${index === slashPosition ? "active" : ""}`}
                                                onClick={(e) => selectSlashCommand(cmd, e)}
                                                onMouseEnter={() => setSlashPosition(index)}
                                            >
                                                <span className="slash-token">
                                                    /{cmd.name}
                                                    {cmd.argsHint && (
                                                        <span className="slash-args">{` ${cmd.argsHint}`}</span>
                                                    )}
                                                </span>
                                                <span className="slash-desc">
                                                    {cmd.description}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* Autocomplete Dropdown */}
                                {showAutocomplete && (
                                    <div className="autocomplete-dropdown">
                                        {filteredFiles.map((file, index) => (
                                            <button
                                                key={file.path}
                                                type="button"
                                                className={`autocomplete-item ${index === autocompletePosition ? "active" : ""}`}
                                                onClick={(e) => selectFile(file, e)}
                                                onMouseEnter={() => setAutocompletePosition(index)}
                                            >
                                                <svg
                                                    className="file-icon"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                >
                                                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                </svg>
                                                <div className="file-info">
                                                    <span className="file-name">{file.name}</span>
                                                    <span className="file-path">{file.path}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                <textarea
                                    ref={inputRef}
                                    rows={1}
                                    className="chat-input"
                                    placeholder={
                                        isGenerating
                                            ? "running… press Esc or Stop to interrupt"
                                            : "write a test, or / for commands"
                                    }
                                    value={inputValue}
                                    onChange={handleInputChange}
                                    onClick={handleInputClick}
                                    onKeyDown={handleKeyDown}
                                />
                                {isGenerating ? (
                                    <button
                                        type="button"
                                        className="send-btn stop-btn"
                                        onClick={() => {
                                            if (handleStop()) {
                                                echoSystemMessage("_Stopping the agent…_");
                                            }
                                        }}
                                        title="Stop the running agent (Esc)"
                                        aria-label="Stop the running agent"
                                    >
                                        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                                            <rect x="6" y="6" width="12" height="12" rx="2" />
                                        </svg>
                                    </button>
                                ) : (
                                    <button type="submit" className="send-btn">
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                                        </svg>
                                    </button>
                                )}
                            </form>
                        </div>
                    )}

                    {/* Files Panel */}
                    {activeTab === "files" &&
                        (filesLoading ? (
                            <div className="loading-panel">
                                <div className="loading-spinner"></div>
                                <span>loading files…</span>
                            </div>
                        ) : (
                            <FilesPanel
                                files={files}
                                activeFilePath={activeFilePath}
                                onFileSelect={onFileSelect}
                                onRefresh={() => {
                                    void refetchTestFiles();
                                }}
                                isRefreshing={filesRefetching && !filesLoading}
                            />
                        ))}
                </>
            )}

            <style>{`
        .sidebar {
          display: flex;
          width: 100%;
          background: var(--bg-bar);
          border-right: 1px solid var(--hair);
          transition: width 0.2s ease;
          font-family: var(--mono);
          color: var(--ink);
          font-size: 12.5px;
        }

        .sidebar.collapsed {
          width: 0;
          overflow: hidden;
          border-right: 0;
        }

        .chat-panel {
          position: relative;
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          overflow: hidden;
          background: var(--bg);
        }

        .scroll-to-bottom {
          position: absolute;
          right: 0.875rem;
          bottom: 4.75rem;
          z-index: 5;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          border-radius: 50%;
          border: 1px solid var(--hair-strong);
          background: var(--bg-elev);
          color: var(--ink-dim);
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
          transition: background 0.12s, color 0.12s, border-color 0.12s;
        }
        .scroll-to-bottom:hover {
          background: var(--bg-hover);
          color: var(--ink);
          border-color: var(--ink-mute);
        }
        .scroll-to-bottom svg {
          width: 15px;
          height: 15px;
        }

        .agent-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0 0.75rem;
          height: 28px;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair);
          font-family: var(--mono);
          font-size: 11px;
          color: var(--ink-dim);
          flex-shrink: 0;
        }

        .agent-icon {
          color: var(--accent);
          flex-shrink: 0;
        }

        .agent-info {
          display: flex;
          align-items: baseline;
          gap: 0.4375rem;
          min-width: 0;
        }
        .agent-title {
          color: var(--accent);
          font-family: var(--mono);
          font-size: 11px;
        }
        .agent-status {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: var(--ink-faint);
          font-size: 11px;
        }
        .agent-status::before {
          content: "/";
          color: var(--ink-faint);
          margin-right: 0.4375rem;
        }
        .agent-status .status-dot {
          width: 6px;
          height: 6px;
          background: var(--pass);
        }
        .agent-status .status-dot.generating {
          background: var(--warn);
          animation: q-pulse 1.4s ease-in-out infinite;
        }

        @keyframes q-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .clear-chat-btn {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          background: transparent;
          border: 1px solid transparent;
          color: var(--ink-faint);
          cursor: pointer;
          transition: color 0.12s, border-color 0.12s, background 0.12s;
        }
        .clear-chat-btn:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--fail);
          border-color: rgba(215, 92, 92, 0.3);
        }
        .clear-chat-btn:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .clear-chat-btn svg {
          width: 12px;
          height: 12px;
          display: block;
        }

        .messages {
          flex: 1 1 0;
          display: flex;
          flex-direction: column;
          gap: 0.875rem;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 0.875rem 0.875rem;
          min-width: 0;
          min-height: 0;
        }

        .message {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.25rem;
          width: 100%;
          min-width: 0;
          max-width: 100%;
        }
        .message.assistant {
          align-items: flex-start;
        }

        .message-bubble {
          max-width: 92%;
          min-width: 0;
          padding: 0.5rem 0.625rem;
          background: var(--bg-elev);
          border: 1px solid var(--hair);
          border-left: 1px solid var(--accent);
          font-family: var(--mono);
          font-size: 12px;
          line-height: 1.55;
          color: var(--ink);
          word-wrap: break-word;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .message.assistant .message-bubble {
          background: var(--bg-bar);
          border: 1px solid var(--hair);
          border-left: 1px solid var(--ink-mute);
          color: var(--ink);
        }

        .message.assistant .message-bubble p {
          margin: 0 0 0.5rem 0;
        }
        .message.assistant .message-bubble p:last-child {
          margin-bottom: 0;
        }

        .inline-code {
          background: var(--bg);
          padding: 0 4px;
          font-family: var(--mono);
          font-size: 11.5px;
          color: var(--accent);
          border: 1px solid var(--hair);
        }

        .code-block-wrapper {
          margin: 0.5rem 0;
          border: 1px solid var(--hair);
          background: var(--bg);
          max-width: 100%;
          min-width: 0;
        }

        .code-block-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.25rem 0.5rem;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair);
        }

        .code-lang {
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          letter-spacing: 0.04em;
        }
        .code-lang::before {
          content: "─ ";
          color: var(--ink-faint);
        }

        .code-block-actions {
          display: flex;
          gap: 0.125rem;
        }

        .code-action-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          padding: 0;
          background: transparent;
          border: 1px solid transparent;
          color: var(--ink-faint);
          cursor: pointer;
          transition: color 0.12s, background 0.12s, border-color 0.12s;
        }
        .code-action-btn:hover {
          background: var(--bg-hover);
          color: var(--accent);
          border-color: var(--hair);
        }
        .code-action-btn svg {
          width: 12px;
          height: 12px;
        }

        .code-pre {
          background: var(--bg-sunken);
          padding: 0.5rem 0.625rem;
          margin: 0;
          overflow-x: auto;
          overflow-y: auto;
          max-height: 320px;
        }

        .code-block {
          font-family: var(--mono);
          font-size: 11.5px;
          color: var(--ink);
          white-space: pre;
        }

        .md-link {
          color: var(--accent);
          text-decoration: none;
        }
        .md-link:hover {
          text-decoration: underline;
        }

        .md-list {
          margin: 0.375rem 0;
          padding-left: 1.125rem;
        }
        .md-list-ordered {
          list-style-type: decimal;
        }
        .md-list-item {
          margin: 0.125rem 0;
        }

        .md-heading {
          margin: 0.625rem 0 0.375rem;
          font-family: var(--mono);
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.005em;
        }
        .md-heading::before {
          content: "# ";
          color: var(--accent);
          font-weight: 400;
        }
        .md-h1 { font-size: 14px; }
        .md-h2 { font-size: 13px; }
        .md-h3 { font-size: 12.5px; }

        .md-blockquote {
          border-left: 1px solid var(--accent);
          padding: 0.125rem 0.625rem;
          margin: 0.5rem 0;
          color: var(--ink-dim);
          background: var(--bg-bar);
        }

        .md-table {
          width: 100%;
          border-collapse: collapse;
          margin: 0.5rem 0;
          font-family: var(--mono);
          font-size: 11.5px;
        }
        .md-th, .md-td {
          border: 1px solid var(--hair);
          padding: 0.25rem 0.5rem;
          text-align: left;
        }
        .md-th {
          background: var(--bg-bar);
          color: var(--ink-faint);
          font-weight: 500;
          font-size: 10.5px;
        }

        .file-mention {
          display: inline;
          padding: 0 4px;
          background: var(--accent-soft);
          border: 1px solid var(--accent-dim);
          color: var(--accent);
          font-family: var(--mono);
          font-size: 11.5px;
          max-width: 100%;
          overflow-wrap: break-word;
          word-break: break-all;
        }
        .message.assistant .file-mention {
          color: var(--accent);
        }

        .message-time {
          font-family: var(--mono);
          font-size: 10px;
          color: var(--ink-mute);
          font-variant-numeric: tabular-nums;
        }

        .chat-input-container {
          position: relative;
          display: flex;
          align-items: flex-end;
          gap: 0;
          padding: 0;
          margin: 0 0.625rem 0.625rem;
          background: var(--bg-elev);
          border: 1px solid var(--hair);
        }
        .chat-input-container:focus-within {
          border-color: var(--accent-dim);
        }

        .autocomplete-dropdown {
          position: absolute;
          bottom: 100%;
          left: -1px;
          right: -1px;
          margin-bottom: 4px;
          max-height: 14rem;
          overflow-y: auto;
          background: var(--bg-elev);
          border: 1px solid var(--hair-strong);
          z-index: 50;
        }

        .autocomplete-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4375rem 0.625rem;
          width: 100%;
          background: transparent;
          border: 0;
          border-bottom: 1px solid var(--hair-soft);
          text-align: left;
          cursor: pointer;
          transition: background 0.1s;
        }
        .autocomplete-item:last-child {
          border-bottom: 0;
        }
        .autocomplete-item:hover,
        .autocomplete-item.active {
          background: var(--bg-hover);
        }

        .autocomplete-item .file-icon {
          width: 12px;
          height: 12px;
          color: var(--ink-faint);
          flex-shrink: 0;
        }
        .autocomplete-item .file-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .autocomplete-item .file-name {
          font-family: var(--mono);
          font-size: 12px;
          color: var(--ink);
        }
        .autocomplete-item .file-path {
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .slash-dropdown {
          max-height: 18rem;
        }
        .slash-dropdown-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.3125rem 0.625rem;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair-soft);
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .slash-dropdown-hint {
          color: var(--ink-faint);
          text-transform: none;
          letter-spacing: 0;
          font-size: 10px;
        }
        .slash-item {
          flex-direction: column;
          align-items: flex-start;
          gap: 0.125rem;
        }
        .slash-token {
          font-family: var(--mono);
          font-size: 12.5px;
          color: var(--accent);
          font-weight: 500;
        }
        .slash-args {
          color: var(--ink-faint);
          font-weight: 400;
        }
        .slash-desc {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--ink-dim);
        }

        .chat-input {
          flex: 1;
          background: transparent;
          border: 0;
          outline: none;
          color: var(--ink);
          font-family: var(--mono);
          font-size: 12.5px;
          line-height: 1.5;
          min-width: 0;
          padding: 0.5rem 0.625rem;
          z-index: 1;
          resize: none;
          max-height: 160px;
          overflow-y: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .chat-input::placeholder {
          color: var(--ink-faint);
        }
        .chat-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          min-height: 35px;
          background: transparent;
          border: 0;
          border-left: 1px solid var(--hair);
          color: var(--accent);
          cursor: pointer;
          transition: background 0.1s;
        }
        .send-btn:hover:not(:disabled) {
          background: var(--accent-dim);
        }
        .send-btn:disabled {
          color: var(--ink-faint);
          cursor: not-allowed;
        }
        .send-btn svg {
          width: 13px;
          height: 13px;
        }
        .stop-btn {
          color: var(--danger, #e5484d);
        }
        .stop-btn:hover:not(:disabled) {
          background: var(--danger-dim, rgba(229, 72, 77, 0.12));
        }
        .stop-btn svg {
          width: 11px;
          height: 11px;
        }

        .typing-indicator {
          display: flex;
          gap: 0.1875rem;
          padding: 0.25rem 0;
          align-items: center;
        }
        .typing-indicator span {
          width: 4px;
          height: 4px;
          background: var(--ink-faint);
          animation: q-typing 1.2s ease-in-out infinite;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.15s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.3s; }

        @keyframes q-typing {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; background: var(--accent); }
        }

        .loading-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.625rem;
          padding: 2rem;
          color: var(--ink-faint);
          font-family: var(--mono);
          font-size: 12px;
        }
        .loading-spinner {
          width: 14px;
          height: 14px;
          border: 1.5px solid var(--hair-strong);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: q-spin 0.8s linear infinite;
        }

        /* Human-in-the-Loop Confirmation */
        .hitl-confirmation {
          padding: 0.625rem 0.75rem;
          background: var(--warn-soft);
          border: 1px solid rgba(217, 164, 65, 0.3);
        }
        .hitl-header {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          margin-bottom: 0.5rem;
          color: var(--warn);
          font-family: var(--mono);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .hitl-header svg {
          width: 12px;
          height: 12px;
          flex-shrink: 0;
        }
        .hitl-message {
          color: var(--ink);
          font-family: var(--mono);
          font-size: 12px;
          margin: 0 0 0.5rem 0;
          line-height: 1.55;
        }
        .hitl-reasons {
          margin: 0 0 0.625rem 0;
          padding-left: 1rem;
          color: var(--ink-dim);
          font-family: var(--mono);
          font-size: 11.5px;
          line-height: 1.55;
        }
        .hitl-reasons li {
          margin-bottom: 0.125rem;
        }
        .hitl-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4375rem;
          margin-bottom: 0.4375rem;
        }
        .hitl-btn {
          flex: 1 1 6.5rem;
          min-width: 6.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4375rem;
          padding: 0.4375rem 0.625rem;
          font-family: var(--mono);
          font-size: 12px;
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s;
          border: 1px solid transparent;
          background: transparent;
        }
        .hitl-btn svg {
          width: 12px;
          height: 12px;
        }
        .hitl-btn.primary {
          background: var(--accent-dim);
          color: var(--accent);
          border-color: var(--accent);
        }
        .hitl-btn.primary:hover:not(:disabled) {
          background: var(--accent);
          color: var(--bg);
        }
        .hitl-btn.secondary {
          background: var(--bg);
          color: var(--ink-dim);
          border-color: var(--hair-strong);
        }
        .hitl-btn.secondary:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--ink);
          border-color: var(--ink-mute);
        }
        .hitl-btn.ghost {
          background: transparent;
          color: var(--ink-dim);
          border-color: var(--line);
        }
        .hitl-btn.ghost:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--ink);
          border-color: var(--ink-mute);
        }
        .hitl-btn.danger {
          background: transparent;
          color: var(--danger, #e5484d);
          border-color: var(--hair-strong);
        }
        .hitl-btn.danger:hover:not(:disabled) {
          background: var(--danger, #e5484d);
          color: var(--bg);
          border-color: var(--danger, #e5484d);
        }
        .hitl-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .hitl-hint {
          margin: 0;
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
        }
        /* Save-approval card variant: shows the test draft, an editable
         * path field, and the saved/rejected outcome inline. */
        .hitl-save .hitl-code-preview {
          margin: 8px 0;
          border: 1px solid var(--line);
          border-radius: 4px;
          background: var(--bg-elev);
          overflow: hidden;
        }
        .hitl-save .hitl-code-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 8px;
          font-family: var(--mono);
          font-size: 10.5px;
          color: var(--ink-faint);
          border-bottom: 1px solid var(--line);
          background: var(--bg);
        }
        .hitl-save .hitl-code-meta {
          opacity: 0.65;
        }
        .hitl-save .hitl-code-preview pre {
          margin: 0;
          padding: 8px 10px;
          max-height: 240px;
          overflow: auto;
          font-family: var(--mono);
          font-size: 11px;
          line-height: 1.45;
          color: var(--ink);
          white-space: pre;
          tab-size: 2;
        }
        .hitl-save .hitl-code-preview code {
          font-family: inherit;
        }
        .hitl-save .hitl-path-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 6px 0 8px;
          font-family: var(--mono);
          font-size: 11px;
          color: var(--ink-faint);
        }
        .hitl-save .hitl-path-row > span {
          flex-shrink: 0;
          text-transform: lowercase;
          letter-spacing: 0.04em;
        }
        .hitl-save .hitl-path-input {
          flex: 1 1 auto;
          min-width: 0;
          padding: 4px 8px;
          font-family: var(--mono);
          font-size: 11px;
          color: var(--ink);
          background: var(--bg-elev);
          border: 1px solid var(--line);
          border-radius: 3px;
          outline: none;
        }
        .hitl-save .hitl-path-input:focus {
          border-color: var(--accent);
        }
        .hitl-save .hitl-path-input:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .hitl-resolved {
          margin: 6px 0 0;
          font-family: var(--mono);
          font-size: 10.5px;
        }
        .hitl-resolved code {
          font-family: inherit;
          background: var(--bg-elev);
          padding: 1px 4px;
          border-radius: 2px;
        }
        .hitl-resolved-ok {
          color: var(--ink);
        }
        .hitl-resolved-warn {
          color: var(--ink-faint);
        }
      `}</style>
        </aside>
    );
}
