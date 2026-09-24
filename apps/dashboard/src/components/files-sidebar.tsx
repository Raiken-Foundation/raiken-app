import { trpc } from "../utils/trpc";
import { FilesPanel, type TestFileItem } from "./files-panel";

interface FilesSidebarProps {
    collapsed: boolean;
    activeFilePath?: string;
    onFileSelect: (filePath: string) => void;
}

/**
 * The testing sidebar, post-chat: just the spec tree. The agent surfaces are
 * the scoped actions (repair, run) in the editor/results panes and the CLI —
 * not an open-ended composer.
 */
export function FilesSidebar({ collapsed, activeFilePath, onFileSelect }: FilesSidebarProps) {
    const { data, isLoading, isFetching, refetch } = trpc.listTestFiles.useQuery({});

    if (collapsed) {
        return <aside className="sidebar collapsed" aria-label="files" />;
    }
    if (isLoading) {
        return (
            <aside className="sidebar">
                <div className="loading-panel">
                    <div className="loading-spinner" />
                    <span>loading files…</span>
                </div>
            </aside>
        );
    }

    const files: TestFileItem[] = (data?.files ?? []).map((file, index) => ({
        id: `test-${index}`,
        name: file.name,
        path: file.path,
        directory: file.directory,
        status: file.status,
    }));

    return (
        <aside className="sidebar" aria-label="files">
            <FilesPanel
                files={files}
                activeFilePath={activeFilePath}
                onFileSelect={onFileSelect}
                onRefresh={() => void refetch()}
                isRefreshing={isFetching && !isLoading}
            />
        </aside>
    );
}
