import type { KeyboardEvent } from "react";
import { Sidebar } from "../../components/sidebar";
import type { DashboardRoute } from "../../utils/slash-commands";

interface TestingSidebarPaneProps {
    sidebarWidth: number;
    isResizing: boolean;
    onMouseDown: () => void;
    onResizeKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
    onSendMessage: (content: string) => void;
    onFileSelect: (filePath: string) => void;
    activeFilePath: string;
    sidebarTab: "chat" | "files";
    sidebarCollapsed: boolean;
    onSidebarTabChange?: (tab: "chat" | "files") => void;
    onNavigateRoute?: (route: DashboardRoute) => void;
    onHitlPendingChange?: (pending: boolean) => void;
    initialPrompt?: string;
    onInitialPromptConsumed?: () => void;
}

/** Sidebar + resize handle — always rendered so chat/HITL state survives view toggles. */
export function TestingSidebarPane({
    sidebarWidth,
    isResizing,
    onMouseDown,
    onResizeKeyDown,
    onSendMessage,
    onFileSelect,
    activeFilePath,
    sidebarTab,
    sidebarCollapsed,
    onSidebarTabChange,
    onNavigateRoute,
    onHitlPendingChange,
    initialPrompt,
    onInitialPromptConsumed,
}: TestingSidebarPaneProps) {
    return (
        <div className="sidebar-container" style={{ width: `${sidebarWidth}px` }}>
            <Sidebar
                onSendMessage={onSendMessage}
                onFileSelect={onFileSelect}
                activeFilePath={activeFilePath}
                activeTab={sidebarTab}
                collapsed={sidebarCollapsed}
                onTabChange={onSidebarTabChange}
                onNavigateRoute={onNavigateRoute}
                onHitlPendingChange={onHitlPendingChange}
                initialPrompt={initialPrompt}
                onInitialPromptConsumed={onInitialPromptConsumed}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window splitter pattern */}
            <div
                className={`resize-handle ${isResizing ? "resizing" : ""}`}
                onMouseDown={onMouseDown}
                onKeyDown={onResizeKeyDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuenow={sidebarWidth}
                aria-valuemin={280}
                aria-valuemax={600}
                tabIndex={0}
            />
        </div>
    );
}
