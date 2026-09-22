import type { KeyboardEvent } from "react";
import { FilesSidebar } from "../../components/files-sidebar";
import "../../components/files-sidebar.css";

interface TestingSidebarPaneProps {
    sidebarWidth: number;
    isResizing: boolean;
    onMouseDown: () => void;
    onResizeKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
    onFileSelect: (filePath: string) => void;
    activeFilePath: string;
    sidebarCollapsed: boolean;
}

/** Sidebar + resize handle. The sidebar is the spec tree; agent actions live
 *  in the editor and results panes as scoped buttons, not a composer. */
export function TestingSidebarPane({
    sidebarWidth,
    isResizing,
    onMouseDown,
    onResizeKeyDown,
    onFileSelect,
    activeFilePath,
    sidebarCollapsed,
}: TestingSidebarPaneProps) {
    return (
        <div className="sidebar-container" style={{ width: `${sidebarWidth}px` }}>
            <FilesSidebar
                collapsed={sidebarCollapsed}
                activeFilePath={activeFilePath}
                onFileSelect={onFileSelect}
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
