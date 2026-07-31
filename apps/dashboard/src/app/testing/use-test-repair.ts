import { type RefObject, useRef, useState } from "react";
import type { DiffReview } from "../../components/code-editor";
import type { TestResult } from "../../components/test-results";
import { trpc } from "../../utils/trpc";
import type { InterpretationSource } from "./types";

interface UseTestRepairOptions {
    filesRef: RefObject<Array<{ id: string; path: string }>>;
    setActiveFileId: (id: string) => void;
    setActiveFilePath: (path: string) => void;
    lastRunTestPath: string;
    lastRunTestCode: string;
    rawTestOutput: string;
    activeFilePath: string;
    openProposedTest: (targetPath: string, code: string) => void;
    lastReportJsonRef: RefObject<unknown>;
}

export function useTestRepair({
    filesRef,
    setActiveFileId,
    setActiveFilePath,
    lastRunTestPath,
    lastRunTestCode,
    rawTestOutput,
    activeFilePath,
    openProposedTest,
    lastReportJsonRef,
}: UseTestRepairOptions) {
    const [interpretation, setInterpretation] = useState<string>("");
    const [isInterpreting, setIsInterpreting] = useState(false);
    const [interpretationSource, setInterpretationSource] = useState<InterpretationSource>(null);
    const [isFixing, setIsFixing] = useState(false);
    const [fixError, setFixError] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [exportedReportPath, setExportedReportPath] = useState<string | null>(null);
    const fixInFlightRef = useRef(false);
    const [diffReview, setDiffReview] = useState<DiffReview | null>(null);

    const interpretMutation = trpc.interpretTestResults.useMutation({
        onSuccess: (data) => {
            setInterpretation(data.interpretation);
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
            setDiffReview({
                targetPath: target,
                fileName,
                original: data.originalCode ?? lastRunTestCode ?? "",
                proposed: data.fixedCode,
                editCount: data.editCount ?? null,
                mode: (data.mode as "edits" | "full" | null) ?? null,
                matchFailed: data.matchFailed ?? false,
            });
            if (target) {
                const targetFile = filesRef.current?.find((f) => f.path === target);
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

    const formatResultsForApi = (results: TestResult[]) =>
        results.map((r) => ({
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

    const handleRequestInterpretation = (results: TestResult[]) => {
        setIsInterpreting(true);
        setInterpretation("");
        setInterpretationSource(null);
        interpretMutation.mutate({
            testResults: formatResultsForApi(results),
            testCode: lastRunTestCode,
            testFilePath: lastRunTestPath || undefined,
            rawOutput: rawTestOutput || undefined,
        });
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

    const handleRequestFix = (results: TestResult[]) => {
        if (fixInFlightRef.current || diffReview) return;
        fixInFlightRef.current = true;
        setFixError(null);
        setIsFixing(true);
        repairMutation.mutate({
            testResults: formatResultsForApi(results),
            testCode: lastRunTestCode,
            testFilePath: lastRunTestPath || undefined,
            rawOutput: rawTestOutput || undefined,
            interpretation: interpretation || undefined,
        });
    };

    const handleExportReport = (
        formats: Array<"html" | "markdown" | "json"> = ["html", "json"],
    ) => {
        if (isExporting || lastReportJsonRef.current == null) return;
        setIsExporting(true);
        setExportedReportPath(null);
        generateReportMutation.mutate({
            report: lastReportJsonRef.current,
            rawOutput: rawTestOutput || undefined,
            testFile: lastRunTestPath || activeFilePath || undefined,
            formats,
        });
    };

    return {
        interpretation,
        interpretationSource,
        isInterpreting,
        isFixing,
        fixError,
        diffReview,
        isExporting,
        exportedReportPath,
        handleRequestInterpretation,
        handleRequestFix,
        handleExportReport,
        handleApplyDiff,
        handleRejectDiff,
    };
}
