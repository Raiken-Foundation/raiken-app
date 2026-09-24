import { type RefObject, useEffect, useRef, useState } from "react";
import type { TestFile } from "../../components/code-editor";
import { trpc } from "../../utils/trpc";

export function useTestFiles() {
    const [activeFileId, setActiveFileId] = useState<string>("");
    const [files, setFiles] = useState<TestFile[]>([]);
    const filesRef = useRef<TestFile[]>([]);
    const [activeFilePath, setActiveFilePath] = useState<string>("");

    const closedPathsRef = useRef<Set<string>>(new Set());
    const skipDiskLoadRef = useRef<string | null>(null);
    const savedContentRef = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    const { data: fileContent, isLoading: contentLoading } = trpc.getFileContent.useQuery(
        { filePath: activeFilePath },
        { enabled: !!activeFilePath },
    );

    useEffect(() => {
        if (!fileContent || !activeFileId) return;
        if (skipDiskLoadRef.current && skipDiskLoadRef.current === activeFilePath) {
            skipDiskLoadRef.current = null;
            return;
        }
        setFiles((prevFiles) =>
            prevFiles.map((file) => {
                if (file.id !== activeFileId) return file;
                const baseline = savedContentRef.current.get(file.id);
                const isDirty =
                    file.content.trim() !== "" &&
                    baseline !== undefined &&
                    file.content !== baseline;
                if (isDirty) return file;
                savedContentRef.current.set(file.id, fileContent.content);
                return { ...file, content: fileContent.content };
            }),
        );
    }, [fileContent, activeFileId, activeFilePath]);

    const activeFile = files.find((f) => f.id === activeFileId);

    const displayFiles = files.map((file) =>
        file.id === activeFileId && contentLoading
            ? { ...file, content: "// Loading file content..." }
            : file,
    );

    const handleContentChange = (fileId: string, content: string) => {
        setFiles((prevFiles) =>
            prevFiles.map((file) => (file.id === fileId ? { ...file, content } : file)),
        );
    };

    const handleFileClose = (fileId: string) => {
        let remainingFiles: TestFile[] = [];
        setFiles((prevFiles) => {
            const closing = prevFiles.find((f) => f.id === fileId);
            if (closing?.path && !closing.path.startsWith("scratch:")) {
                closedPathsRef.current.add(closing.path);
            }
            remainingFiles = prevFiles.filter((f) => f.id !== fileId);
            return remainingFiles;
        });

        if (fileId === activeFileId) {
            if (remainingFiles.length > 0) {
                setActiveFileId(remainingFiles[0].id);
                setActiveFilePath(remainingFiles[0].path);
            } else {
                setActiveFileId("");
                setActiveFilePath("");
            }
        }
    };

    const handleFileSelect = (fileId: string) => {
        setActiveFileId(fileId);
        const selectedFile = files.find((f) => f.id === fileId);
        if (selectedFile) {
            setActiveFilePath(selectedFile.path);
        }
    };

    const handleFileSelectByPath = (filePath: string) => {
        if (filePath.startsWith("scratch:")) {
            const fileName = filePath.replace("scratch:", "");
            const content = sessionStorage.getItem(`scratch:${fileName}`) || "";

            const existing = files.find((f) => f.path === filePath);
            if (existing) {
                setFiles((prev) =>
                    prev.map((f) =>
                        f.id === existing.id
                            ? { ...f, name: fileName, path: filePath, content }
                            : f,
                    ),
                );
                setActiveFileId(existing.id);
                setActiveFilePath(filePath);
                return;
            }

            const scratchFile: TestFile = {
                id: `scratch-${Date.now()}`,
                name: fileName,
                path: filePath,
                content,
                status: "pending",
                passedCount: 0,
                failedCount: 0,
            };
            setFiles((prev) => [...prev, scratchFile]);
            setActiveFileId(scratchFile.id);
            setActiveFilePath(filePath);
            return;
        }

        setActiveFilePath(filePath);
        closedPathsRef.current.delete(filePath);

        const name = filePath.split("/").pop() || filePath;
        const existing = files.find((f) => f.path === filePath);

        if (existing) {
            setActiveFileId(existing.id);
        } else {
            const newFile: TestFile = {
                id: `graph:${filePath}`,
                name,
                path: filePath,
                content: "",
                status: "pending",
                passedCount: 0,
                failedCount: 0,
            };
            setFiles((prev) => [...prev, newFile]);
            setActiveFileId(newFile.id);
        }
    };

    const handleNewFile = () => {
        const timestamp = Date.now();
        const fileName = `untitled-${timestamp}.spec.ts`;
        const newFile: TestFile = {
            id: `new-${timestamp}`,
            name: fileName,
            path: `e2e/${fileName}`,
            content: `import { test, expect } from '@playwright/test';\n\ntest.describe('New Test Suite', () => {\n  test('should pass', async ({ page }) => {\n    // Your test code here\n  });\n});\n`,
            status: "pending",
            passedCount: 0,
            failedCount: 0,
        };
        setFiles((prev) => [...prev, newFile]);
        setActiveFileId(newFile.id);
        setActiveFilePath(newFile.path);
    };

    const openProposedTest = (targetPath: string, code: string) => {
        const isRealPath = targetPath && !targetPath.startsWith("scratch:");

        if (isRealPath) {
            closedPathsRef.current.delete(targetPath);
            skipDiskLoadRef.current = targetPath;
            const name = targetPath.split("/").pop() || targetPath;
            const existing = filesRef.current.find((f) => f.path === targetPath);
            if (existing) {
                setFiles((prev) =>
                    prev.map((f) =>
                        f.id === existing.id
                            ? { ...f, name, path: targetPath, content: code, status: "pending" }
                            : f,
                    ),
                );
                setActiveFileId(existing.id);
            } else {
                const newFile: TestFile = {
                    id: `fix-${Date.now()}`,
                    name,
                    path: targetPath,
                    content: code,
                    status: "pending",
                    passedCount: 0,
                    failedCount: 0,
                };
                setFiles((prev) => [newFile, ...prev]);
                setActiveFileId(newFile.id);
            }
            setActiveFilePath(targetPath);
            return;
        }

        const scratchName = `${targetPath?.replace("scratch:", "") || "fixed-test"}`;
        const scratchPath = `scratch:${scratchName}`;
        sessionStorage.setItem(scratchPath, code);
        const scratchFile: TestFile = {
            id: `fix-scratch-${Date.now()}`,
            name: scratchName,
            path: scratchPath,
            content: code,
            status: "pending",
            passedCount: 0,
            failedCount: 0,
        };
        setFiles((prev) => [scratchFile, ...prev]);
        setActiveFileId(scratchFile.id);
        setActiveFilePath(scratchPath);
    };

    return {
        files,
        setFiles,
        filesRef,
        activeFileId,
        setActiveFileId,
        activeFilePath,
        setActiveFilePath,
        activeFile,
        displayFiles,
        closedPathsRef,
        skipDiskLoadRef,
        savedContentRef,
        handleContentChange,
        handleFileClose,
        handleFileSelect,
        handleFileSelectByPath,
        handleNewFile,
        openProposedTest,
    };
}

export function isFileDirty(
    file: TestFile,
    savedContentRef: RefObject<Map<string, string>>,
): boolean {
    const baseline = savedContentRef.current?.get(file.id);
    return file.content.trim() !== "" && baseline !== undefined && file.content !== baseline;
}
