import { FilesPanel, type TestFileItem } from "../../files-panel";

interface SidebarFilesTabProps {
    filesLoading: boolean;
    filesRefetching: boolean;
    files: TestFileItem[];
    activeFilePath?: string;
    onFileSelect?: (filePath: string) => void;
    onRefresh: () => void;
}

export function SidebarFilesTab({
    filesLoading,
    filesRefetching,
    files,
    activeFilePath,
    onFileSelect,
    onRefresh,
}: SidebarFilesTabProps) {
    if (filesLoading) {
        return (
            <div className="loading-panel">
                <div className="loading-spinner"></div>
                <span>loading files…</span>
            </div>
        );
    }

    return (
        <FilesPanel
            files={files}
            activeFilePath={activeFilePath}
            onFileSelect={onFileSelect}
            onRefresh={onRefresh}
            isRefreshing={filesRefetching && !filesLoading}
        />
    );
}
