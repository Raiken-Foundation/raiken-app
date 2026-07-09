import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CodeEditor, type DiffReview, type TestFile } from "../components/code-editor";
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

// Parse an already-extracted Playwright JSON reporter object into TestResults.
// Split out so we can feed it the SERVER's robustly-extracted `results` object
// (balanced-brace scan) instead of re-running a greedy regex over raw stdout on
// the client — the server parse is authoritative and immune to surrounding
// npm/npx noise.
function parsePlaywrightReport(
    // The Playwright JSON reporter shape isn't typed here; the parser uses
    // `any` throughout, matching the rest of this module.
    // biome-ignore lint/suspicious/noExplicitAny: untyped reporter payload
    jsonData: any,
): { results: TestResult[]; summary: TestSummary } {
    const results: TestResult[] = [];
    const summary = {
        suites: { ...emptySummary.suites },
        tests: { ...emptySummary.tests },
        time: emptySummary.time,
    };

    try {
        {
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
                                    // Use the FINAL attempt, not the first, so a
                                    // test that fails then passes on retry reads
                                    // as passed — matching TestRunner's
                                    // last-attempt aggregation. Reading [0] made
                                    // the dashboard disagree with the runner.
                                    const testResult = test.results?.[test.results.length - 1];
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
        console.warn("Failed to parse Playwright JSON report:", e);
    }

    return { results, summary };
}

// Parse raw Playwright stdout: prefer the embedded JSON reporter object,
// falling back to line-based text scraping when no JSON is present.
function parsePlaywrightOutput(output: string): { results: TestResult[]; summary: TestSummary } {
    try {
        const jsonMatch = output.match(/\{[\s\S]*"config"[\s\S]*"suites"[\s\S]*\}/);
        if (jsonMatch) {
            return parsePlaywrightReport(JSON.parse(jsonMatch[0]));
        }
    } catch (e) {
        console.warn("Failed to parse Playwright JSON output:", e);
    }

    const results: TestResult[] = [];
    const summary = {
        suites: { ...emptySummary.suites },
        tests: { ...emptySummary.tests },
        time: emptySummary.time,
    };

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

// Coerce an arbitrary tab name into a valid Playwright spec filename that the
// server's strict validator (`^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$`)
// will accept. Used for auto-save-on-run and rename so the user never has to
// hand-craft a compliant name.
function normalizeSpecFileName(rawName: string, content?: string): string {
    let base = (rawName || "").trim().replace(/^scratch:/, "");
    // Already a valid spec name → keep it.
    if (/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/.test(base)) return base;

    // Strip any extension, then sanitize the stem.
    let stem = base.replace(/\.(spec|test)\.(ts|tsx|js|jsx)$/i, "").replace(/\.(ts|tsx|js|jsx)$/i, "");
    stem = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // Fall back to the test.describe title, then a generic name.
    if (!stem && content) {
        const m = content.match(/test\.describe\(\s*['"`](.+?)['"`]/);
        if (m) stem = m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }
    if (!stem) stem = "generated-test";
    base = `${stem}.spec.ts`;
    return base;
}

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
    const [isFixing, setIsFixing] = useState(false);
    const [fixError, setFixError] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [exportedReportPath, setExportedReportPath] = useState<string | null>(null);
    // Guards against overlapping repair requests: a repair is in flight, or a
    // proposed diff is already open awaiting review. Prevents a stale second
    // fix from clobbering the diff the user is currently reviewing.
    const fixInFlightRef = useRef(false);
    // A proposed AI fix awaiting review in the editor's diff view. `targetPath`
    // (part of DiffReview) is where the fix will land when applied, and also ties
    // the diff to a single tab so the rest of the editor stays navigable.
    const [diffReview, setDiffReview] = useState<DiffReview | null>(null);

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
    // We only need this query's loading flag for the indexing banner — the
    // result no longer drives which tabs are open (see below).
    const { isLoading: filesLoading } = trpc.getGraphFiles.useQuery(
        { limit: 1000, offset: 0 },
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

    // Paths the user explicitly closed. The code-graph list refetches on every
    // file-change bump; without this, a refetch would re-open a tab the user
    // just closed. Cleared for a path whenever the user re-opens it.
    const closedPathsRef = useRef<Set<string>>(new Set());

    // NOTE: the editor no longer auto-opens every test file in the repo as a
    // tab on load. That old "merge the whole code graph into tabs" behaviour
    // produced a wall of tabs before the user did anything — not how a world-
    // class editor behaves. Tabs now open on demand only:
    //   • from the Files panel (handleFileSelectByPath)
    //   • when a test is generated/saved (those handlers open their own tab)
    //   • when a new/scratch file is created
    // Open tabs are managed directly by those handlers and by handleFileClose,
    // so there's nothing to reconcile against the graph here. The full test
    // list still lives in the Files panel.

    // When we inject AI-generated content into a tab that points at a real
    // on-disk path (e.g. the "Fix test" flow), the getFileContent query for
    // that path would otherwise re-load the *stale* disk copy and clobber the
    // proposed fix. This guard holds the path whose next disk-load we must skip.
    const skipDiskLoadRef = useRef<string | null>(null);

    // The tab id whose run is currently in flight. The run result must be
    // applied to THIS tab, not `activeFileId` — otherwise switching tabs while
    // a run is in flight paints pass/fail onto the wrong file.
    const runningFileIdRef = useRef<string | null>(null);

    // Baseline (last known on-disk / last-saved) content per tab id. Used to
    // detect a dirty buffer so a background disk re-load can't clobber unsaved
    // edits.
    const savedContentRef = useRef<Map<string, string>>(new Map());

    // Update file content when loaded
    useEffect(() => {
        if (!fileContent || !activeFileId) return;
        if (skipDiskLoadRef.current && skipDiskLoadRef.current === activeFilePath) {
            // We just placed unsaved AI-fixed content in this tab — keep it
            // instead of overwriting with the on-disk version. Clear the
            // one-shot guard so future selections load from disk normally.
            skipDiskLoadRef.current = null;
            return;
        }
        setFiles((prevFiles) =>
            prevFiles.map((file) => {
                if (file.id !== activeFileId) return file;
                // Dirty-buffer guard: if the tab has unsaved edits (content
                // differs from the baseline we loaded), don't overwrite them
                // with a disk re-load.
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

    const [lastSaveFileName, setLastSaveFileName] = useState("");

    const saveTestMutation = trpc.saveGeneratedTest.useMutation({
        onSuccess: (data) => {
            // Prefer the exact bytes written to disk so the editor shows disk
            // truth (matches formatting/cleanup applied server-side).
            const savedContent = data.content ?? generatedTest;
            // Prefer the server's actual path basename — dedup may have renamed
            // the file (e.g. `login-2.spec.ts`), so the requested name can be stale.
            const name = data.filePath.split("/").pop() || lastSaveFileName || "test.spec.ts";
            // Re-opening this path — it should no longer be treated as closed.
            closedPathsRef.current.delete(data.filePath);

            // If a tab already points at this path (e.g. the user had the file
            // open, or a scratch tab was just persisted), update it in place
            // instead of adding a second tab for the same on-disk file. All of
            // this is derived from the functional-update snapshot so a save that
            // lands concurrently with other tab mutations doesn't act on a stale
            // `files` closure (which could spawn a duplicate tab).
            let targetId = "";
            setFiles((prev) => {
                const existing = prev.find((f) => f.path === data.filePath);
                if (existing) {
                    targetId = existing.id;
                    savedContentRef.current.set(existing.id, savedContent);
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
                savedContentRef.current.set(newFile.id, savedContent);
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
        let testDir: string | undefined;
        // Overwrite only when we're deliberately targeting the open file; a
        // brand-new derived name must not clobber an unrelated existing spec.
        let overwritingOpenFile = false;

        // If the user has a real (non-scratch) test file highlighted, overwrite
        // it instead of deriving a brand-new file name.
        if (activeFilePath && !activeFilePath.startsWith("scratch:")) {
            const lastSlash = activeFilePath.lastIndexOf("/");
            testDir = lastSlash >= 0 ? activeFilePath.slice(0, lastSlash) : undefined;
            fileName = lastSlash >= 0 ? activeFilePath.slice(lastSlash + 1) : activeFilePath;
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

    const [isSavingFile, setIsSavingFile] = useState(false);
    const [savedFileId, setSavedFileId] = useState<string | null>(null);

    // Bare save mutation used to auto-persist a scratch/unsaved buffer right
    // before it runs (no heavy onSuccess side-effects — the caller updates the
    // tab in place). Keeps "run = saved" true without a manual save step.
    const persistOnRunMutation = trpc.saveGeneratedTest.useMutation();

    // Rename a real test file on disk (or a scratch buffer in memory).
    const renameMutation = trpc.renameTestFile.useMutation();

    // Save file content to disk
    const saveFileMutation = trpc.saveFileContent.useMutation({
        onSuccess: (_data, variables) => {
            setIsSavingFile(false);
            // Find the saved file from the freshest state (functional read,
            // returning `prev` unchanged so this doesn't trigger a re-render)
            // rather than a stale `files` closure.
            let savedId: string | null = null;
            setFiles((prev) => {
                const file = prev.find((f) => f.path === variables.filePath);
                if (file) {
                    savedId = file.id;
                    // The buffer is now clean — update the dirty-guard baseline
                    // so a subsequent disk re-load isn't flagged as unsaved.
                    savedContentRef.current.set(file.id, variables.content);
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

            const result = data as {
                success?: boolean;
                stdout?: string;
                stderr?: string;
                busy?: boolean;
                // biome-ignore lint/suspicious/noExplicitAny: untyped reporter payload
                results?: any;
            };

            // Server rejected the run because another run is already in flight
            // for this project. The test did NOT execute, so don't parse the
            // (empty) output as a failure — just tell the user and restore the
            // tab from its transient "running" state.
            if (result.busy) {
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

            const output = result.stdout || result.stderr || "";

            // Store raw output
            setRawTestOutput(output);

            // Prefer the server's robustly-extracted JSON report (balanced-brace
            // scan). Only fall back to scraping stdout when the server couldn't
            // produce one (e.g. a crash before the reporter emitted).
            const parsed =
                result.results && typeof result.results === "object"
                    ? parsePlaywrightReport(result.results)
                    : parsePlaywrightOutput(output);
            setTestResults(parsed.results);
            setTestSummary(parsed.summary);

            // Update status on the tab that was actually run (captured at run
            // time), not whatever tab happens to be active now.
            const targetFileId = runningFileIdRef.current ?? activeFileId;
            runningFileIdRef.current = null;
            if (targetFileId) {
                setFiles((prevFiles) =>
                    prevFiles.map((file) =>
                        file.id === targetFileId
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
            // Restore the tab that was mid-run: leaving it stuck on "running"
            // makes the spinner spin forever and blocks the Run button.
            const erroredFileId = runningFileIdRef.current ?? activeFileId;
            runningFileIdRef.current = null;
            setIsRunningTests(false);
            setRawTestOutput(`Error: ${error.message}`);
            setTestResults([]);
            setTestSummary(emptySummary);
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

    // Drop AI-generated code into the editor as an unsaved buffer so the user
    // can review it, run it (the run path handles unsaved buffers), and save
    // when happy. We never write to disk here — the fix is a proposal.
    const openProposedTest = (targetPath: string, code: string) => {
        const isRealPath = targetPath && !targetPath.startsWith("scratch:");

        if (isRealPath) {
            closedPathsRef.current.delete(targetPath);
            // Guard the disk-load effect so it doesn't overwrite our proposal
            // with the (stale) on-disk copy of this same path.
            skipDiskLoadRef.current = targetPath;
            const name = targetPath.split("/").pop() || targetPath;
            // Reuse a tab by PATH only. Name-based matching conflated distinct
            // files that share a basename (e.g. e2e/login.spec.ts vs
            // tests/login.spec.ts) into one tab.
            const existing = files.find((f) => f.path === targetPath);
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

        // No real path (scratch buffer / unsaved). Stash in a scratch tab so
        // the user can review, run, then Save-As to the right location.
        const scratchName = (targetPath?.replace("scratch:", "") || "fixed-test") + "";
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

    const handleApplyDiff = (finalContent: string) => {
        const target = diffReview?.targetPath ?? "";
        setDiffReview(null);
        setFixError(null);
        fixInFlightRef.current = false;
        openProposedTest(target, finalContent);
    };

    const handleRejectDiff = () => {
        setDiffReview(null);
        setFixError(null);
        fixInFlightRef.current = false;
    };

    const repairMutation = trpc.repairTestResults.useMutation({
        onSuccess: (data) => {
            setIsFixing(false);
            fixInFlightRef.current = false;
            if (data.error || !data.fixedCode) {
                setFixError(data.error || "The AI could not produce a corrected test. Try again.");
                return;
            }
            const target = data.filePath || lastRunTestPath || "";
            const fileName = target ? target.split("/").pop() || target : "fixed-test";
            // Show the fix as a reviewable diff (original vs proposed) rather than
            // silently swapping the buffer. Apply/Reject lives in the editor.
            setDiffReview({
                targetPath: target,
                fileName,
                original: data.originalCode ?? lastRunTestCode ?? "",
                proposed: data.fixedCode,
                editCount: data.editCount ?? null,
                mode: (data.mode as "edits" | "full" | null) ?? null,
                matchFailed: data.matchFailed ?? false,
            });
            // The diff is shown only on its target file's tab (so other tabs stay
            // navigable). Focus that tab if it's open, otherwise the review would
            // be hidden behind whichever file happens to be active.
            if (target) {
                const targetFile = files.find((f) => f.path === target);
                if (targetFile) {
                    setActiveFileId(targetFile.id);
                    setActiveFilePath(target);
                }
            }
        },
        onError: (error) => {
            console.error("❌ Test repair failed:", error);
            setIsFixing(false);
            fixInFlightRef.current = false;
            setFixError(`Test repair failed: ${error.message}`);
        },
    });

    const generateReportMutation = trpc.generateTestReport.useMutation({
        onSuccess: (data) => {
            setIsExporting(false);
            setExportedReportPath(data.htmlPath ?? data.files[0] ?? null);
        },
        onError: (error) => {
            console.error("❌ Report generation failed:", error);
            setIsExporting(false);
            setExportedReportPath(null);
        },
    });

    const handleExportReport = () => {
        if (isExporting || !rawTestOutput) return;
        setIsExporting(true);
        setExportedReportPath(null);
        // The raw stdout carries Playwright's JSON reporter object; the server
        // extracts it. Screenshots are read from disk (test-results/) and
        // embedded into the HTML.
        generateReportMutation.mutate({
            rawReportJson: rawTestOutput,
            rawOutput: rawTestOutput,
            testFile: lastRunTestPath || activeFilePath || undefined,
            formats: ["html", "json"],
        });
    };

    // Take the current failing results + (if present) the AI analysis the user
    // just read, and generate a corrected spec into the editor for review.
    const handleRequestFix = (results: TestResult[]) => {
        // Don't start a second repair while one is in flight or a diff is
        // already open for review — that would replace the diff the user is
        // looking at with a stale result.
        if (fixInFlightRef.current || diffReview) return;
        fixInFlightRef.current = true;
        setFixError(null);
        setIsFixing(true);
        // Forward attachments too: the server reads the failure-screenshot bytes
        // off disk and sends them to a vision-capable model so the fix is
        // grounded in what the page actually rendered — not just error text.
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

        repairMutation.mutate({
            testResults: formattedResults,
            testCode: lastRunTestCode,
            testFilePath: lastRunTestPath || undefined,
            rawOutput: rawTestOutput || undefined,
            interpretation: interpretation || undefined,
        });
    };

    const handleFileClose = (fileId: string) => {
        // Derive everything from the functional-update snapshot so rapid closes
        // don't operate on a stale `files` closure (which could re-add a just-
        // closed path or pick the wrong next-active tab).
        let remainingFiles: TestFile[] = [];
        setFiles((prevFiles) => {
            const closing = prevFiles.find((f) => f.id === fileId);
            // Remember real paths the user closes so the next graph refetch
            // doesn't silently re-open them. (Scratch paths vanish anyway.)
            if (closing?.path && !closing.path.startsWith("scratch:")) {
                closedPathsRef.current.add(closing.path);
            }
            remainingFiles = prevFiles.filter((f) => f.id !== fileId);
            return remainingFiles;
        });

        // If closing the active file, switch to another one (based on the fresh
        // remaining list captured above).
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

    const handleRunTests = async (fileId: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return;

        // Auto-save-on-run: a scratch/unsaved draft is persisted to a real,
        // deduped spec file first, so running a generated test always leaves a
        // saved file on disk (and a real path to analyze/fix against) instead
        // of vanishing with the throwaway temp. Real files are saved server-
        // side by runTests itself, so they don't need this.
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
                closedPathsRef.current.delete(saved.filePath);
                // Keep our in-memory content — the disk copy is identical (server
                // cleaned it), so guard the next disk-load and update the baseline.
                skipDiskLoadRef.current = saved.filePath;
                savedContentRef.current.set(fileId, saved.content);
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
                // Save failed — fall back to running the scratch buffer as before
                // rather than blocking the run entirely.
                console.warn("Auto-save before run failed; running scratch buffer:", err);
            }
        }

        setIsRunningTests(true);

        // Snapshot the file's content + path AT RUN TIME. The AI insights
        // flow uses these (not `activeFile`) so the model always sees the
        // exact code that produced the results — even if the user clicks
        // a different editor tab between running and analyzing, or edits
        // the file while the run is in flight.
        setLastRunTestPath(runFile.path);
        setLastRunTestCode(runFile.content);
        runningFileIdRef.current = fileId;

        // Update file status to running
        setFiles((prevFiles) =>
            prevFiles.map((f) => (f.id === fileId ? { ...f, status: "running" } : f)),
        );

        // Send the current buffer so the run executes exactly what's on screen:
        // a real file is saved-on-run, a scratch draft runs from a temp file.
        // No manual save step required.
        runTestsMutation.mutate({
            testFile: runFile.path,
            inlineContent: runFile.content,
            inlineFileName: runFile.name,
        });
    };

    const handleRenameFile = async (fileId: string, rawNewName: string) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return;
        const newName = normalizeSpecFileName(rawNewName, file.content);
        if (newName === file.name) return;

        // Scratch buffers live only in memory + sessionStorage — rename locally.
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
            closedPathsRef.current.delete(res.filePath);
            // Carry the dirty-guard baseline over to the new path so a disk
            // re-load isn't mistaken for unsaved edits.
            const base = savedContentRef.current.get(fileId);
            if (base !== undefined) savedContentRef.current.set(fileId, base);
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

            // Reuse an existing tab by scratch path so opening the same draft
            // twice doesn't produce two tabs.
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
        // User is opening this path — it's no longer "closed".
        closedPathsRef.current.delete(filePath);

        // Check if the file is already open — match by PATH only. A distinct
        // on-disk path always gets its own tab even if the basename collides.
        const name = filePath.split("/").pop() || filePath;
        const existing = files.find((f) => f.path === filePath);

        if (existing) {
            setActiveFileId(existing.id);
        } else {
            // Create a new file entry for this test file. Use a path-stable id
            // (`graph:<path>`) so re-opening the same path reuses this tab and
            // never duplicates.
            const newFile: TestFile = {
                id: `graph:${filePath}`,
                name,
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

    // Background indexing state. We deliberately DON'T gate the whole view on
    // this any more: blocking the entire workspace (chat included) behind a
    // full-screen spinner made a slow code-graph build look like the app had
    // hung ("infinite loading"). The chat/agent surface is the primary tool and
    // must always be usable; indexing is surfaced as a slim, non-blocking banner
    // over the editor instead.
    const isIndexing = filesLoading || isBuilding;

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
                    {isIndexing && (
                        <div className="indexing-banner" aria-live="polite">
                            <span className="indexing-spinner" aria-hidden="true" />
                            <span>{isBuilding ? "building code graph…" : "loading files…"}</span>
                        </div>
                    )}
                    <CodeEditor
                        files={displayFiles}
                        activeFileId={activeFileId}
                        onFileSelect={handleFileSelect}
                        onFileClose={handleFileClose}
                        onContentChange={handleContentChange}
                        onRunTests={handleRunTests}
                        onNewFile={handleNewFile}
                        onSaveFile={handleSaveFile}
                        onRenameFile={handleRenameFile}
                        onDeleteFile={handleDeleteFile}
                        isRunningTests={isRunningTests}
                        isSaving={isSavingFile}
                        savedFileId={savedFileId}
                        diffReview={diffReview}
                        onApplyDiff={handleApplyDiff}
                        onRejectDiff={handleRejectDiff}
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
                onRequestFix={handleRequestFix}
                isFixing={isFixing}
                fixError={fixError}
                onExportReport={handleExportReport}
                isExporting={isExporting}
                exportedReportPath={exportedReportPath}
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

        .indexing-banner {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.3125rem 0.75rem;
          background: var(--bg-bar);
          border-bottom: 1px solid var(--hair);
          color: var(--ink-dim);
          font-family: var(--mono);
          font-size: 11px;
          flex-shrink: 0;
        }
        .indexing-spinner {
          width: 11px;
          height: 11px;
          border: 1.5px solid var(--hair-strong);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: q-spin 0.8s linear infinite;
        }
      `}</style>
        </div>
    );
}
