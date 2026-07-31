import { splitTestSavePath } from "@raiken/shared";
import { type Dispatch, type RefObject, type SetStateAction, useState } from "react";
import type { TestFile } from "../../components/code-editor";
import { trpc } from "../../utils/trpc";
import { normalizeSpecFileName } from "./normalize-spec-file-name";

interface UseTestMutationsOptions {
    files: TestFile[];
    setFiles: Dispatch<SetStateAction<TestFile[]>>;
    activeFileId: string;
    setActiveFileId: (id: string) => void;
    activeFilePath: string;
    setActiveFilePath: (path: string) => void;
    closedPathsRef: RefObject<Set<string>>;
    savedContentRef: RefObject<Map<string, string>>;
    handleFileClose: (fileId: string) => void;
}

export function useTestMutations({
    files,
    setFiles,
    activeFileId,
    setActiveFileId,
    activeFilePath,
    setActiveFilePath,
    closedPathsRef,
    savedContentRef,
    handleFileClose,
}: UseTestMutationsOptions) {
    const utils = trpc.useUtils();
    const [generatedTest, setGeneratedTest] = useState("");
    const [lastSaveFileName, setLastSaveFileName] = useState("");
    const [isSavingFile, setIsSavingFile] = useState(false);
    const [savedFileId, setSavedFileId] = useState<string | null>(null);

    const saveTestMutation = trpc.saveGeneratedTest.useMutation({
        onSuccess: (data) => {
            const savedContent = data.content ?? generatedTest;
            const name = data.filePath.split("/").pop() || lastSaveFileName || "test.spec.ts";
            closedPathsRef.current?.delete(data.filePath);

            let targetId = "";
            setFiles((prev) => {
                const existing = prev.find((f) => f.path === data.filePath);
                if (existing) {
                    targetId = existing.id;
                    savedContentRef.current?.set(existing.id, savedContent);
                    return prev.map((f) =>
                        f.id === existing.id
                            ? { ...f, name, path: data.filePath, content: savedContent }
                            : f,
                    );
                }
                const newFile: TestFile = {
                    id: `graph:${data.filePath}`,
                    name,
                    path: data.filePath,
                    content: savedContent,
                    status: "pending",
                    passedCount: 0,
                    failedCount: 0,
                };
                targetId = newFile.id;
                savedContentRef.current?.set(newFile.id, savedContent);
                return [newFile, ...prev];
            });
            setActiveFileId(targetId);
            setActiveFilePath(data.filePath);
            setGeneratedTest("");
            utils.listTestFiles.invalidate();
            utils.getFileContent.invalidate({ filePath: data.filePath });
        },
        onError: (error) => {
            console.error("Failed to save test:", error);
        },
    });

    const persistOnRunMutation = trpc.saveGeneratedTest.useMutation();
    const renameMutation = trpc.renameTestFile.useMutation();

    const saveFileMutation = trpc.saveFileContent.useMutation({
        onSuccess: (_data, variables) => {
            setIsSavingFile(false);
            let savedId: string | null = null;
            setFiles((prev) => {
                const file = prev.find((f) => f.path === variables.filePath);
                if (file) {
                    savedId = file.id;
                    savedContentRef.current?.set(file.id, variables.content);
                }
                return prev;
            });
            if (savedId) {
                setSavedFileId(savedId);
                setTimeout(() => setSavedFileId(null), 2000);
            }
        },
        onError: (error) => {
            console.error("❌ Failed to save file:", error);
            setIsSavingFile(false);
            alert(`Failed to save: ${error.message}`);
        },
    });

    const deleteFileMutation = trpc.deleteTestFile.useMutation({
        onSuccess: () => {
            utils.listTestFiles.invalidate();
        },
        onError: (error) => {
            console.error("❌ Failed to delete file:", error);
            alert(`Failed to delete: ${error.message}`);
        },
    });

    const handleSaveFile = (fileId: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file || !file.path) return;
        if (file.path.startsWith("scratch:")) {
            alert("Save this file first using the save dialog.");
            return;
        }
        setIsSavingFile(true);
        saveFileMutation.mutate({ filePath: file.path, content: file.content });
    };

    const handleDeleteFile = (fileId: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file || !file.path) return;
        if (file.path.startsWith("scratch:")) {
            handleFileClose(fileId);
            return;
        }
        deleteFileMutation.mutate({ filePath: file.path });
        handleFileClose(fileId);
    };

    const handleSendMessage = (generatedContent: string) => {
        if (!generatedContent || generatedContent.trim().length === 0) return;

        let cleanContent = generatedContent;
        const fenceMatch = generatedContent.match(
            /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i,
        );
        if (fenceMatch) {
            cleanContent = fenceMatch[1].trim();
        }

        if (!cleanContent.includes("import") && !cleanContent.includes("test")) return;

        let fileName = "generated-test.spec.ts";
        let testDir: string | undefined;
        let overwritingOpenFile = false;

        if (activeFilePath && !activeFilePath.startsWith("scratch:")) {
            ({ fileName, testDir } = splitTestSavePath(activeFilePath));
            overwritingOpenFile = true;
        } else {
            const match = cleanContent.match(/test\.describe\(['"](.+?)['"]/);
            if (match) {
                const testName = match[1]
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "");
                fileName = `${testName}.spec.ts`;
            }
        }

        setGeneratedTest(cleanContent);
        setLastSaveFileName(fileName);
        saveTestMutation.mutate({
            fileName,
            content: cleanContent,
            testDir,
            avoidOverwrite: !overwritingOpenFile,
        });
    };

    const handleRenameFile = async (fileId: string, rawNewName: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return;
        const newName = normalizeSpecFileName(rawNewName, file.content);
        if (newName === file.name) return;

        if (file.path.startsWith("scratch:")) {
            const newPath = `scratch:${newName}`;
            try {
                sessionStorage.removeItem(file.path);
                sessionStorage.setItem(newPath, file.content);
            } catch {
                /* non-critical */
            }
            setFiles((prev) =>
                prev.map((f) => (f.id === fileId ? { ...f, name: newName, path: newPath } : f)),
            );
            if (activeFileId === fileId) setActiveFilePath(newPath);
            return;
        }

        try {
            const res = await renameMutation.mutateAsync({
                filePath: file.path,
                newFileName: newName,
            });
            const realName = res.filePath.split("/").pop() || newName;
            closedPathsRef.current?.delete(res.filePath);
            const base = savedContentRef.current?.get(fileId);
            if (base !== undefined) savedContentRef.current?.set(fileId, base);
            setFiles((prev) =>
                prev.map((f) =>
                    f.id === fileId ? { ...f, name: realName, path: res.filePath } : f,
                ),
            );
            if (activeFileId === fileId) setActiveFilePath(res.filePath);
            utils.listTestFiles.invalidate();
            utils.getGraphFiles.invalidate();
        } catch (err) {
            alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    return {
        handleSaveFile,
        handleDeleteFile,
        handleSendMessage,
        handleRenameFile,
        isSavingFile,
        savedFileId,
        persistOnRunMutation,
    };
}
