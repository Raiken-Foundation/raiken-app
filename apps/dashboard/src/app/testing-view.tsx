import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CodeEditor, type TestFile } from "../components/code-editor";
import { Header } from "../components/header";
import { Sidebar } from "../components/sidebar";
import { type TestResult, TestResults, type TestSummary } from "../components/test-results";
import { TicketSyncBar } from "../components/ticket-sync";
import { trpc } from "../utils/trpc";

// Empty initial state for test results
const emptyTestResults: TestResult[] = [];

const emptySummary: TestSummary = {
    suites: { passed: 0, failed: 0, total: 0 },
    tests: { passed: 0, failed: 0, total: 0 },
    time: 0,
};

// Helper function to parse Playwright JSON output into TestResults
function parsePlaywrightOutput(output: string): { results: TestResult[]; summary: TestSummary } {
    const results: TestResult[] = [];
    const summary = {
        suites: { ...emptySummary.suites },
        tests: { ...emptySummary.tests },
        time: emptySummary.time,
    };

    // Try to parse as JSON first (from --reporter=json)
    try {
        // Find the JSON object in the output
        const jsonMatch = output.match(/\{[\s\S]*"config"[\s\S]*"suites"[\s\S]*\}/);
        if (jsonMatch) {
            const jsonData = JSON.parse(jsonMatch[0]);

            // Parse stats
            if (jsonData.stats) {
                summary.tests.passed = jsonData.stats.expected || 0;
                summary.tests.failed = jsonData.stats.unexpected || 0;
                summary.tests.total =
                    summary.tests.passed + summary.tests.failed + (jsonData.stats.skipped || 0);
                summary.time = (jsonData.stats.duration || 0) / 1000; // Convert ms to seconds
            }

            // Parse suites recursively
            let testId = 0;
            const parseSuites = (suites: any[], parentTitle = "") => {
                for (const suite of suites) {
                    const suiteName = parentTitle ? `${parentTitle} > ${suite.title}` : suite.title;

                    // Parse specs (tests)
                    if (suite.specs) {
                        for (const spec of suite.specs) {
                            if (spec.tests) {
                                for (const test of spec.tests) {
                                    const testResult = test.results?.[0];
                                    if (testResult) {
                                        testId++;
                                        const status =
                                            testResult.status === "passed"
                                                ? "passed"
                                                : testResult.status === "failed"
                                                  ? "failed"
                                                  : "skipped";

                                        const result: TestResult = {
                                            id: spec.id || String(testId),
                                            name: spec.title,
                                            suite: suiteName,
                                            status,
                                            duration: testResult.duration,
                                        };

                                        // Add error details for failed tests
                                        if (testResult.error) {
                                            result.error = {
                                                message: testResult.error.message,
                                                snippet: testResult.error.snippet,
                                                location: testResult.error.location,
                                            };
                                        }

                                        // Add attachments. The Playwright JSON
                                        // reporter shape isn't typed in this
                                        // file (the surrounding parser uses
                                        // `any` throughout), but the attachment
                                        // contract is narrow enough to pin
                                        // locally without a wider refactor.
                                        if (
                                            testResult.attachments &&
                                            testResult.attachments.length > 0
                                        ) {
                                            type RawAttachment = {
                                                name?: string;
                                                contentType?: string;
                                                path?: string;
                                            };
                                            result.attachments = (
                                                testResult.attachments as RawAttachment[]
                                            ).map((att) => ({
                                                name: att.name ?? "",
                                                contentType: att.contentType ?? "",
                                                path: att.path,
                                            }));
                                        }

                                        results.push(result);
                                    }
                                }
                            }
                        }
                    }

                    // Recurse into nested suites
                    if (suite.suites) {
                        parseSuites(suite.suites, suiteName);
                    }
                }
            };

            if (jsonData.suites) {
                parseSuites(jsonData.suites);
            }

            // Parse top-level errors (syntax errors, missing imports, etc.)
            if (jsonData.errors && Array.isArray(jsonData.errors)) {
                for (const err of jsonData.errors) {
                    testId++;
                    results.push({
                        id: `error-${testId}`,
                        name: err.location
                            ? `Compilation Error in ${err.location.file?.split("/").pop() || "unknown"}`
                            : "Compilation Error",
                        suite: "Build Errors",
                        status: "failed",
                        error: {
                            message: err.message,
                            snippet: err.snippet,
                            location: err.location,
                        },
                    });
                    summary.tests.failed++;
                    summary.tests.total++;
                }
            }

            // Calculate suite stats
            const suiteNames = new Set(results.map((r) => r.suite));
            summary.suites.total = suiteNames.size;
            summary.suites.failed = summary.tests.failed > 0 ? 1 : 0;
            summary.suites.passed = summary.suites.total - summary.suites.failed;

            return { results, summary };
        }
    } catch (e) {
        console.warn("Failed to parse Playwright JSON output:", e);
    }

    // Fallback: Try to parse text output
    const lines = output.split("\n");
    let currentSuite = "Tests";
    let testId = 0;

    for (const line of lines) {
        const suiteMatch = line.match(/^\s*(?:›|>)\s*(.+?)(?:\s*›|$)/);
        if (suiteMatch) {
            currentSuite = suiteMatch[1].trim();
        }

        const passedMatch = line.match(/[✓✔√]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*m?s\))?$/);
        if (passedMatch) {
            testId++;
            results.push({
                id: String(testId),
                name: passedMatch[1].trim(),
                suite: currentSuite,
                status: "passed",
                duration: passedMatch[2] ? parseInt(passedMatch[2], 10) : undefined,
            });
        }

        const failedMatch = line.match(/[✗✕×]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*m?s\))?$/);
        if (failedMatch) {
            testId++;
            results.push({
                id: String(testId),
                name: failedMatch[1].trim(),
                suite: currentSuite,
                status: "failed",
                duration: failedMatch[2] ? parseInt(failedMatch[2], 10) : undefined,
            });
        }

        const passedCount = line.match(/(\d+)\s+passed/);
        const failedCount = line.match(/(\d+)\s+failed/);
        const timeMatch = line.match(/(\d+(?:\.\d+)?)\s*s(?:econds?)?/);

        if (passedCount) summary.tests.passed = parseInt(passedCount[1], 10);
        if (failedCount) summary.tests.failed = parseInt(failedCount[1], 10);
        if (timeMatch) summary.time = parseFloat(timeMatch[1]);
    }

    summary.tests.total = results.length;
    summary.suites.total = new Set(results.map((r) => r.suite)).size;
    summary.suites.passed = summary.tests.failed === 0 ? summary.suites.total : 0;
    summary.suites.failed = summary.tests.failed > 0 ? 1 : 0;

    return { results, summary };
}

const loadingStyles = `
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 0.625rem;
    color: var(--ink-dim);
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg);
  }
  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--hair-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: q-spin 0.8s linear infinite;
  }
`;

interface TestingViewProps {
    sidebarTab?: "chat" | "files";
    sidebarCollapsed?: boolean;
    onSidebarTabChange?: (tab: "chat" | "files") => void;
    pendingPrompt?: string;
    onPromptConsumed?: () => void;
    onNavigateRoute?: (route: import("../utils/slash-commands").DashboardRoute) => void;
}

export function TestingView({
    sidebarTab = "chat",
    sidebarCollapsed = false,
    onSidebarTabChange,
    pendingPrompt,
    onPromptConsumed,
    onNavigateRoute,
}: TestingViewProps) {
    const queryClient = useQueryClient();
    const [activeFileId, setActiveFileId] = useState<string>("");
    const [ticketPrompt, setTicketPrompt] = useState<string | undefined>();
    const [files, setFiles] = useState<TestFile[]>([]);
    const [isBuilding, setIsBuilding] = useState(false);
    const [activeFilePath, setActiveFilePath] = useState<string>("");
    const [generatedTest, setGeneratedTest] = useState<string>("");
    const [sidebarWidth, setSidebarWidth] = useState(320);
    const [isResizing, setIsResizing] = useState(false);
    const [isRunningTests, setIsRunningTests] = useState(false);
    const [testResults, setTestResults] = useState<TestResult[]>(emptyTestResults);
    const [testSummary, setTestSummary] = useState<TestSummary>(emptySummary);
    const [rawTestOutput, setRawTestOutput] = useState<string>("");
    const [interpretation, setInterpretation] = useState<string>("");
    const [isInterpreting, setIsInterpreting] = useState(false);

    // Snapshot of the file that was ACTUALLY run, captured at run-time so
    // the AI insights flow can't accidentally analyse stale-editor content.
    // Pre-fix `testCode` came from `activeFile?.content`, which is whichever
    // tab is selected — not necessarily the file whose results are on
    // screen. When the user clicked through to a different test file before
    // hitting "Analyze with AI", the model received mismatched code and
    // results and invented explanations that didn't match the artifacts.
    // We snapshot here at run-time and pass through to the mutation; the
    // editor tab can change without affecting analysis fidelity.
    const [lastRunTestPath, setLastRunTestPath] = useState<string>("");
    const [lastRunTestCode, setLastRunTestCode] = useState<string>("");

    // The server tells us whether it analysed the on-disk file or fell
    // back to our in-memory snapshot. Surfaced as a small dim banner in
    // the AI insights view so the user can decide whether to trust the
    // diagnosis (disk = freshest, snapshot-fallback = file may have been
    // moved/deleted/locked between run and analyze).
    const [interpretationSource, setInterpretationSource] = useState<
        "disk" | "client-snapshot" | "client-snapshot-fallback" | null
    >(null);

    // Get tRPC utils for query invalidation
    const utils = trpc.useUtils();

    // Poll the file-watcher bump so externally-created files (e.g. via
    // `raiken cover`) refresh the Files panel without a manual click.
    // The bump query is intentionally trivial (single integer); the heavier
    // getGraphFiles + listTestFiles queries are invalidated only when the
    // bump actually changes.
    const lastBumpRef = useRef<number | null>(null);
    const { data: bumpData } = trpc.getFileChangeBump.useQuery(undefined, {
        refetchInterval: 1500,
        refetchIntervalInBackground: false,
    });
    useEffect(() => {
        const bump = bumpData?.bump;
        if (bump === undefined) return;
        if (lastBumpRef.current === null) {
            lastBumpRef.current = bump;
            return;
        }
        if (bump !== lastBumpRef.current) {
            lastBumpRef.current = bump;
            utils.getGraphFiles.invalidate();
            utils.listTestFiles.invalidate();
        }
    }, [bumpData?.bump, utils]);

    // Fetch project info
    const { data: projectInfo } = trpc.getProjectInfo.useQuery();

    // Fetch code graph stats
    const { data: statsData } = trpc.getGraphStats.useQuery({});

    // Build code graph mutation
    const buildGraphMutation = trpc.buildCodeGraph.useMutation({
        onSuccess: () => {
            setIsBuilding(false);
            queryClient.invalidateQueries();
        },
        onError: (error) => {
            console.error("❌ Failed to build code graph:", error);
            setIsBuilding(false);
        },
    });

    // Fetch files from code graph
    const { data: graphFiles, isLoading: filesLoading } = trpc.getGraphFiles.useQuery(
        { limit: 100, offset: 0 },
        { enabled: (statsData?.totalFiles ?? 0) > 0 },
    );

    // Fetch file content when a file is selected
    const { data: fileContent, isLoading: contentLoading } = trpc.getFileContent.useQuery(
        { filePath: activeFilePath },
        { enabled: !!activeFilePath },
    );

    // Build graph on first load if no files exist
    useEffect(() => {
        if (statsData && statsData.totalFiles === 0 && !isBuilding) {
            setIsBuilding(true);
            buildGraphMutation.mutate({ path: ".", persist: true });
        }
    }, [statsData]);

    // Convert graph files to TestFile format (only test files)
    useEffect(() => {
        if (graphFiles?.files) {
            // Filter for test files only
            const testFiles = graphFiles.files.filter((file) =>
                /\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(file.path),
            );

            const convertedFiles: TestFile[] = testFiles.map((file, index) => ({
                id: `graph-${index}`,
                name: file.path.split("/").pop() || file.path,
                path: file.path,
                content: "", // Will be loaded separately when selected
                status: "pending" as const,
                passedCount: 0,
                failedCount: 0,
            }));
            setFiles(convertedFiles);
        }
    }, [graphFiles]);

    // Update file content when loaded
    useEffect(() => {
        if (fileContent && activeFileId) {
            setFiles((prevFiles) =>
                prevFiles.map((file) =>
                    file.id === activeFileId ? { ...file, content: fileContent.content } : file,
                ),
            );
        }
    }, [fileContent, activeFileId]);

    const activeFile = files.find((f) => f.id === activeFileId);

    const [lastSaveFileName, setLastSaveFileName] = useState("");

    const saveTestMutation = trpc.saveGeneratedTest.useMutation({
        onSuccess: (data) => {
            const newFile: TestFile = {
                id: Date.now().toString(),
                name: lastSaveFileName || data.filePath.split("/").pop() || "test.spec.ts",
                path: data.filePath,
                content: generatedTest,
                status: "pending",
                passedCount: 0,
                failedCount: 0,
            };
            setFiles((prev) => [newFile, ...prev]);
            setActiveFileId(newFile.id);
            setActiveFilePath(newFile.path);
            setGeneratedTest("");
            utils.listTestFiles.invalidate();
        },
        onError: (error) => {
            console.error("Failed to save test:", error);
        },
    });

    const handleSendMessage = (generatedContent: string) => {
        if (!generatedContent || generatedContent.trim().length === 0) return;

        // Extract code from markdown fences if present
        let cleanContent = generatedContent;
        const fenceMatch = generatedContent.match(
            /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/i,
        );
        if (fenceMatch) {
            cleanContent = fenceMatch[1].trim();
        }

        // Only save if the content looks like valid test code
        if (!cleanContent.includes("import") && !cleanContent.includes("test")) return;

        let fileName = "generated-test.spec.ts";
        const match = cleanContent.match(/test\.describe\(['"](.+?)['"]/);
        if (match) {
            const testName = match[1]
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
            fileName = `${testName}.spec.ts`;
        }

        setGeneratedTest(cleanContent);
        setLastSaveFileName(fileName);
        saveTestMutation.mutate({ fileName, content: cleanContent });
    };

    const [isSavingFile, setIsSavingFile] = useState(false);
    const [savedFileId, setSavedFileId] = useState<string | null>(null);

    // Save file content to disk
    const saveFileMutation = trpc.saveFileContent.useMutation({
        onSuccess: (_data, variables) => {
            setIsSavingFile(false);
            // Flash "Saved" for the file that was saved
            const file = files.find((f) => f.path === variables.filePath);
            if (file) setSavedFileId(file.id);
            setTimeout(() => setSavedFileId(null), 2000);
        },
        onError: (error) => {
            console.error("❌ Failed to save file:", error);
            setIsSavingFile(false);
            alert(`Failed to save: ${error.message}`);
        },
    });

    // Delete file from disk
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
        // Don't save scratch files that haven't been persisted
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
            // Just remove from state
            handleFileClose(fileId);
            return;
        }
        deleteFileMutation.mutate({ filePath: file.path });
        handleFileClose(fileId);
    };

    const handleContentChange = (fileId: string, content: string) => {
        setFiles((prevFiles) =>
            prevFiles.map((file) => (file.id === fileId ? { ...file, content } : file)),
        );
    };

    // Run tests mutation
    const runTestsMutation = trpc.runTests.useMutation({
        onSuccess: (data) => {
            setIsRunningTests(false);

            const result = data as { success?: boolean; stdout?: string; stderr?: string };
            const output = result.stdout || result.stderr || "";

            // Store raw output
            setRawTestOutput(output);

            // Parse the output into structured results
            const parsed = parsePlaywrightOutput(output);
            setTestResults(parsed.results);
            setTestSummary(parsed.summary);

            // Update file status based on results
            if (activeFileId) {
                setFiles((prevFiles) =>
                    prevFiles.map((file) =>
                        file.id === activeFileId
                            ? {
                                  ...file,
                                  status: result.success ? "passed" : "failed",
                                  passedCount: parsed.summary.tests.passed,
                                  failedCount: parsed.summary.tests.failed,
                              }
                            : file,
                    ),
                );
            }
        },
        onError: (error) => {
            console.error("❌ Test execution failed:", error);
            setIsRunningTests(false);
            setRawTestOutput(`Error: ${error.message}`);
            setTestResults([]);
            setTestSummary(emptySummary);
        },
    });

    // Interpret test results mutation
    const interpretMutation = trpc.interpretTestResults.useMutation({
        onSuccess: (data) => {
            setInterpretation(data.interpretation);
            // `testCodeSource` is null when the server early-returned (no API
            // key) and a string discriminant when it actually ran the model.
            setInterpretationSource(data.testCodeSource ?? null);
            setIsInterpreting(false);
        },
        onError: (error) => {
            console.error("❌ Interpretation failed:", error);
            setInterpretation(`Error getting interpretation: ${error.message}`);
            setInterpretationSource(null);
            setIsInterpreting(false);
        },
    });

    const handleRequestInterpretation = (results: TestResult[]) => {
        setIsInterpreting(true);
        setInterpretation("");
        setInterpretationSource(null);

        // Forward ALL the evidence we already have on screen:
        //   - per-test attachments (failure screenshot, video, trace) so
        //     the model can reference them by name in its diagnosis.
        //   - rawTestOutput which contains Playwright's full per-action
        //     `Call log:` and any console messages from the page — this
        //     is the ground truth that distinguishes "selector mismatch"
        //     from "page not loaded" from "click intercepted".
        //   - testFilePath so the SERVER can read the file from disk —
        //     Playwright reads from disk at run time, so the on-disk
        //     copy is the most accurate source for what produced these
        //     results. The server falls back to `testCode` (our run-time
        //     snapshot) only for scratch buffers or read failures.
        //   - testCode (snapshot from handleRunTests) as the fallback.
        const formattedResults = results.map((r) => ({
            name: r.name,
            suite: r.suite,
            status: r.status,
            duration: r.duration,
            error: r.error
                ? {
                      message: r.error.message,
                      snippet: r.error.snippet,
                      location: r.error.location,
                  }
                : undefined,
            attachments: r.attachments?.map((a) => ({
                name: a.name,
                contentType: a.contentType,
                path: a.path,
            })),
        }));

        interpretMutation.mutate({
            testResults: formattedResults,
            testCode: lastRunTestCode,
            testFilePath: lastRunTestPath || undefined,
            rawOutput: rawTestOutput || undefined,
        });
    };

    const handleFileClose = (fileId: string) => {
        // Remove file from open files
        setFiles((prevFiles) => prevFiles.filter((f) => f.id !== fileId));

        // If closing the active file, switch to another one
        if (fileId === activeFileId) {
            const remainingFiles = files.filter((f) => f.id !== fileId);
            if (remainingFiles.length > 0) {
                setActiveFileId(remainingFiles[0].id);
                setActiveFilePath(remainingFiles[0].path);
            } else {
                setActiveFileId("");
                setActiveFilePath("");
            }
        }
    };

    const handleRunTests = (fileId: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return;

        setIsRunningTests(true);

        // Snapshot the file's content + path AT RUN TIME. The AI insights
        // flow uses these (not `activeFile`) so the model always sees the
        // exact code that produced the results — even if the user clicks
        // a different editor tab between running and analyzing, or edits
        // the file while the run is in flight.
        setLastRunTestPath(file.path);
        setLastRunTestCode(file.content);

        // Update file status to running
        setFiles((prevFiles) =>
            prevFiles.map((f) => (f.id === fileId ? { ...f, status: "running" } : f)),
        );

        runTestsMutation.mutate({
            testFile: file.path,
        });
    };

    const handleFileSelect = (fileId: string) => {
        setActiveFileId(fileId);
        const selectedFile = files.find((f) => f.id === fileId);
        if (selectedFile) {
            setActiveFilePath(selectedFile.path);
        }
    };

    // Handle file selection by path (from sidebar)
    const handleFileSelectByPath = (filePath: string) => {
        // Handle scratch files (from code blocks)
        if (filePath.startsWith("scratch:")) {
            const fileName = filePath.replace("scratch:", "");
            const content = sessionStorage.getItem(`scratch:${fileName}`) || "";

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

        // Check if file already exists in our files list
        const file = files.find((f) => f.path === filePath);

        if (file) {
            setActiveFileId(file.id);
        } else {
            // Create a new file entry for this test file
            const newFile: TestFile = {
                id: `selected-${Date.now()}`,
                name: filePath.split("/").pop() || filePath,
                path: filePath,
                content: "", // Will be loaded by the query
                status: "pending",
                passedCount: 0,
                failedCount: 0,
            };
            setFiles((prev) => [...prev, newFile]);
            setActiveFileId(newFile.id);
        }
    };

    // Handle creating a new empty file
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

    // Resize handlers
    const handleMouseDown = () => {
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newWidth = e.clientX;
                if (newWidth >= 280 && newWidth <= 600) {
                    setSidebarWidth(newWidth);
                }
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        if (isResizing) {
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
            return () => {
                document.removeEventListener("mousemove", handleMouseMove);
                document.removeEventListener("mouseup", handleMouseUp);
            };
        }
    }, [isResizing]);

    // Loading state
    if (filesLoading || isBuilding) {
        return (
            <div className="testing-view">
                <div className="loading-state">
                    <div className="spinner" />
                    <p>{isBuilding ? "building code graph…" : "loading files…"}</p>
                </div>
                <style>{loadingStyles}</style>
                <style>{`
          .testing-view {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            background: var(--bg);
            overflow: hidden;
          }
        `}</style>
            </div>
        );
    }

    // Show loading indicator in editor while content loads
    const displayFiles = files.map((file) =>
        file.id === activeFileId && contentLoading
            ? { ...file, content: "// Loading file content..." }
            : file,
    );

    return (
        <div className="testing-view">
            <Header projectName={projectInfo?.path?.split("/").pop() || "raiken-app"} />
            <TicketSyncBar
                onGenerateTest={(prompt) => {
                    onSidebarTabChange?.("chat");
                    setTicketPrompt(prompt);
                }}
            />

            <div className="main-content">
                <div className="sidebar-container" style={{ width: `${sidebarWidth}px` }}>
                    <Sidebar
                        onSendMessage={handleSendMessage}
                        onFileSelect={handleFileSelectByPath}
                        activeFilePath={activeFilePath}
                        activeTab={sidebarTab}
                        collapsed={sidebarCollapsed}
                        onTabChange={onSidebarTabChange}
                        onNavigateRoute={onNavigateRoute}
                        initialPrompt={ticketPrompt || pendingPrompt}
                        onInitialPromptConsumed={() => {
                            if (ticketPrompt) setTicketPrompt(undefined);
                            onPromptConsumed?.();
                        }}
                    />
                    <div
                        className={`resize-handle ${isResizing ? "resizing" : ""}`}
                        onMouseDown={handleMouseDown}
                    />
                </div>

                <div className="editor-section">
                    <CodeEditor
                        files={displayFiles}
                        activeFileId={activeFileId}
                        onFileSelect={handleFileSelect}
                        onFileClose={handleFileClose}
                        onContentChange={handleContentChange}
                        onRunTests={handleRunTests}
                        onNewFile={handleNewFile}
                        onSaveFile={handleSaveFile}
                        onDeleteFile={handleDeleteFile}
                        isRunningTests={isRunningTests}
                        isSaving={isSavingFile}
                        savedFileId={savedFileId}
                    />
                </div>
            </div>

            {/* Test Results - Full Width at Bottom.
                `testCode` is the run-time snapshot used as a fallback when
                the server can't read from disk (scratch files, moved/
                deleted files). The server prefers reading the on-disk
                copy of `lastRunTestPath` because Playwright reads from
                disk at run time, so the on-disk version is what actually
                produced these results. */}
            <TestResults
                results={testResults}
                summary={testSummary}
                filePath={lastRunTestPath || activeFile?.path}
                isRunning={isRunningTests}
                rawOutput={rawTestOutput}
                testCode={lastRunTestCode}
                onRequestInterpretation={handleRequestInterpretation}
                interpretation={interpretation}
                interpretationSource={interpretationSource}
                isInterpreting={isInterpreting}
            />

            <style>{`
        .testing-view {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          background: var(--bg);
          overflow: hidden;
        }

        .main-content {
          flex: 1;
          display: flex;
          overflow: hidden;
          min-height: 0;
        }

        .sidebar-container {
          position: relative;
          flex-shrink: 0;
          display: flex;
          overflow: hidden;
        }

        .resize-handle {
          position: absolute;
          right: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          cursor: col-resize;
          background: transparent;
          z-index: 100;
          transition: background 0.15s;
        }
        .resize-handle:hover,
        .resize-handle.resizing {
          background: var(--accent);
        }

        .editor-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-height: 0;
          border-left: 1px solid var(--hair);
        }
      `}</style>
        </div>
    );
}
