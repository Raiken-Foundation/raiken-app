import type { DiffReview, TestFile } from "../../components/code-editor";
import type { TestResult, TestSummary } from "../../components/test-results";
import type { DashboardRoute } from "../../utils/slash-commands";

export type { DiffReview, TestFile, TestResult, TestSummary };

export interface ServerParsedRun {
    tests: Array<{
        id: string;
        name: string;
        suite: string;
        status: "passed" | "failed" | "skipped";
        duration?: number;
        error?: {
            message?: string;
            snippet?: string;
            location?: { file: string; line: number; column: number };
        };
        attachments?: Array<{ name: string; contentType: string; path?: string; body?: string }>;
    }>;
    summary: {
        suites: { passed: number; failed: number; total: number };
        tests: { passed: number; failed: number; total: number };
        timeSeconds: number;
    };
}

export interface DashboardRunResult {
    success?: boolean;
    busy?: boolean;
    cancelled?: boolean;
}

export type RunDisposition = "busy" | "cancelled" | "passed" | "failed";

export interface TestingViewProps {
    sidebarTab?: "chat" | "files";
    sidebarCollapsed?: boolean;
    onSidebarTabChange?: (tab: "chat" | "files") => void;
    pendingPrompt?: string;
    onPromptConsumed?: () => void;
    onNavigateRoute?: (route: DashboardRoute) => void;
    /** Bubbled straight up from `Sidebar` — see its prop of the same name. */
    onHitlPendingChange?: (pending: boolean) => void;
}

export type InterpretationSource = "disk" | "client-snapshot" | "client-snapshot-fallback" | null;
