import { type Dispatch, type RefObject, type SetStateAction, useRef, useState } from "react";
import type { TestFile } from "../../components/code-editor";
import type { TestResult, TestSummary } from "../../components/test-results";
import { trpc } from "../../utils/trpc";
import { emptySummary } from "./constants";
import { normalizeSpecFileName } from "./normalize-spec-file-name";
import { classifyRunResult, parseRunOutput } from "./run-output-parser";
import type { ServerParsedRun } from "./types";

interface UseTestRunOptions {
    files: TestFile[];
    setFiles: Dispatch<SetStateAction<TestFile[]>>;
    activeFileId: string;
    setActiveFilePath: (path: string) => void;
    closedPathsRef: RefObject<Set<string>>;
    skipDiskLoadRef: RefObject<string | null>;
    savedContentRef: RefObject<Map<string, string>>;
    persistOnRunMutation: ReturnType<typeof trpc.saveGeneratedTest.useMutation>;
}

export function useTestRun({
    files,
    setFiles,
    activeFileId,
    setActiveFilePath,
    closedPathsRef,
    skipDiskLoadRef,
    savedContentRef,
    persistOnRunMutation,
}: UseTestRunOptions) {
    const [isRunningTests, setIsRunningTests] = useState(false);
    const [testResults, setTestResults] = useState<TestResult[]>([]);
    const [testSummary, setTestSummary] = useState<TestSummary>(emptySummary);
    const [rawTestOutput, setRawTestOutput] = useState<string>("");
    // biome-ignore lint/suspicious/noExplicitAny: untyped reporter payload
    const lastReportJsonRef = useRef<any>(null);
    const runningFileIdRef = useRef<string | null>(null);
    /**
     * Set synchronously on click, unlike `isRunningTests`, which only updates
     * on the next render and stays false across the `await` in the scratch-file
     * autosave.
     */
    const runInFlightRef = useRef(false);
    const [lastRunTestPath, setLastRunTestPath] = useState<string>("");
    const [lastRunTestCode, setLastRunTestCode] = useState<string>("");

    const runTestsMutation = trpc.runTests.useMutation({
        onSuccess: (data) => {
            setIsRunningTests(false);
            runInFlightRef.current = false;

            const result = data as {
                success?: boolean;
                stdout?: string;
                stderr?: string;
                busy?: boolean;
                cancelled?: boolean;
                // biome-ignore lint/suspicious/noExplicitAny: untyped reporter payload
                results?: any;
                parsedRun?: ServerParsedRun | null;
            };
            const disposition = classifyRunResult(result);

            if (disposition === "busy") {
                const busyFileId = runningFileIdRef.current ?? activeFileId;
                runningFileIdRef.current = null;
                setRawTestOutput(
                    "A test run is already in progress for this project. Please wait for it to finish before running again.",
                );
                if (busyFileId) {
                    setFiles((prevFiles) =>
                        prevFiles.map((file) =>
                            file.id === busyFileId && file.status === "running"
                                ? { ...file, status: "pending" }
                                : file,
                        ),
                    );
                }
                return;
            }

            if (disposition === "cancelled") {
                const cancelledFileId = runningFileIdRef.current ?? activeFileId;
                runningFileIdRef.current = null;
                setRawTestOutput("Test run cancelled.");
                setTestResults([]);
                setTestSummary(emptySummary);
                lastReportJsonRef.current = null;
                if (cancelledFileId) {
                    setFiles((prevFiles) =>
                        prevFiles.map((file) =>
                            file.id === cancelledFileId
                                ? {
                                      ...file,
                                      status: "pending",
                                      passedCount: undefined,
                                      failedCount: undefined,
                                  }
                                : file,
                        ),
                    );
                }
                return;
            }

            const { output, results, summary } = parseRunOutput(result);
            setRawTestOutput(output);

            const hasJsonReport = result.results && typeof result.results === "object";
            lastReportJsonRef.current = hasJsonReport ? result.results : null;

            setTestResults(results);
            setTestSummary(summary);

            const targetFileId = runningFileIdRef.current ?? activeFileId;
            runningFileIdRef.current = null;
            if (targetFileId) {
                setFiles((prevFiles) =>
                    prevFiles.map((file) =>
                        file.id === targetFileId
                            ? {
                                  ...file,
                                  status: disposition,
                                  passedCount: summary.tests.passed,
                                  failedCount: summary.tests.failed,
                              }
                            : file,
                    ),
                );
            }
        },
        onError: (error) => {
            console.error("❌ Test execution failed:", error);
            const erroredFileId = runningFileIdRef.current ?? activeFileId;
            runningFileIdRef.current = null;
            runInFlightRef.current = false;
            setIsRunningTests(false);
            setRawTestOutput(`Error: ${error.message}`);
            setTestResults([]);
            setTestSummary(emptySummary);
            lastReportJsonRef.current = null;
            if (erroredFileId) {
                setFiles((prevFiles) =>
                    prevFiles.map((file) =>
                        file.id === erroredFileId && file.status === "running"
                            ? { ...file, status: "pending" }
                            : file,
                    ),
                );
            }
        },
    });

    const cancelTestRunMutation = trpc.cancelTestRun.useMutation({
        onSuccess: (result) => {
            if (result.success) setRawTestOutput("Stopping the active test run…");
        },
    });

    const handleRunTests = async (fileId: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return;
        // The server runs one suite per project at a time. A second start would
        // reassign `runningFileIdRef`, so the first run's results would land on
        // the second file and the first would stay stuck on "running".
        if (runInFlightRef.current) return;
        runInFlightRef.current = true;

        let runFile = file;
        if (file.path.startsWith("scratch:")) {
            try {
                const fileName = normalizeSpecFileName(file.name, file.content);
                const saved = await persistOnRunMutation.mutateAsync({
                    fileName,
                    content: file.content,
                    avoidOverwrite: true,
                });
                const realName = saved.filePath.split("/").pop() || fileName;
                closedPathsRef.current?.delete(saved.filePath);
                skipDiskLoadRef.current = saved.filePath;
                savedContentRef.current?.set(fileId, saved.content);
                try {
                    sessionStorage.removeItem(file.path);
                } catch {
                    /* sessionStorage may be unavailable — non-critical */
                }
                setFiles((prev) =>
                    prev.map((f) =>
                        f.id === fileId
                            ? { ...f, name: realName, path: saved.filePath, content: saved.content }
                            : f,
                    ),
                );
                if (activeFileId === fileId) setActiveFilePath(saved.filePath);
                runFile = { ...file, name: realName, path: saved.filePath, content: saved.content };
            } catch (err) {
                console.warn("Auto-save before run failed; running scratch buffer:", err);
            }
        }

        setIsRunningTests(true);
        setLastRunTestPath(runFile.path);
        setLastRunTestCode(runFile.content);
        runningFileIdRef.current = fileId;

        setFiles((prevFiles) =>
            prevFiles.map((f) => (f.id === fileId ? { ...f, status: "running" } : f)),
        );

        runTestsMutation.mutate({
            testFile: runFile.path,
            inlineContent: runFile.content,
            inlineFileName: runFile.name,
        });
    };

    const canExportReport = lastReportJsonRef.current != null;

    return {
        isRunningTests,
        testResults,
        testSummary,
        rawTestOutput,
        lastRunTestPath,
        lastRunTestCode,
        lastReportJsonRef,
        canExportReport,
        handleRunTests,
        cancelTestRunMutation,
    };
}
