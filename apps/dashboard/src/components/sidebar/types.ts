import type { DashboardRoute } from "../../utils/slash-commands";

export interface HITLConfirmation {
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
        workflowId?: string;
    };
    kind?: "save_approval" | "run_approval";
    testCode?: string;
    suggestedPath?: string;
    overwriteTarget?: boolean;
    testName?: string;
    testFile?: string;
}

export interface Message {
    id: string;
    content: string;
    timestamp: string;
    isUser: boolean;
    isLoading?: boolean;
    fileMentions?: string[];
    hitlData?: HITLConfirmation;
    activity?: string[];
}

export type SaveApprovalResolution = {
    status: "saved" | "rejected" | "handled";
    filePath?: string;
    error?: string;
};

export type RunApprovalResolution = {
    status: "ran" | "skipped" | "cancelled" | "handled";
    passed?: boolean;
    error?: string;
};

export interface SidebarProps {
    onSendMessage?: (message: string) => void;
    onFileSelect?: (filePath: string) => void;
    activeFilePath?: string;
    activeTab?: "chat" | "files";
    collapsed?: boolean;
    onTabChange?: (tab: "chat" | "files") => void;
    initialPrompt?: string;
    onInitialPromptConsumed?: () => void;
    onNavigateRoute?: (route: DashboardRoute) => void;
    onHitlPendingChange?: (pending: boolean) => void;
}

export interface AgentStreamEvent {
    error?: import("@raiken/shared").AgentStreamErrorField;
    chunk?: string;
    done?: boolean;
    workflowId?: string;
    correlationId?: string;
    runId?: string;
    operationId?: string;
}
