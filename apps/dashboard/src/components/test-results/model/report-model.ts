import type {
    CategorizedArtifact,
    CategorizedArtifacts,
    PlaywrightOutcomeStatus,
    SuiteTreeNode,
    TestResult,
} from "../types";

/** Strip ANSI escape/control bytes from Playwright error messages. */
export function stripAnsiCodes(str: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape/control bytes is the point of this regex
    return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\x00-\x1F\x7F]/g, "");
}

/** Whether a test outcome should surface failure UX (errors, fix actions). */
export function isFailureOutcome(status: PlaywrightOutcomeStatus): boolean {
    return status !== "passed" && status !== "skipped";
}

/** CSS/status bucket for list rows and badges. */
export function statusBucket(
    status: PlaywrightOutcomeStatus,
): "passed" | "failed" | "skipped" {
    if (status === "passed") return "passed";
    if (status === "skipped") return "skipped";
    return "failed";
}

/** Human-readable Playwright outcome label. */
export function outcomeLabel(status: PlaywrightOutcomeStatus): string {
    switch (status) {
        case "flaky":
            return "FLAKY";
        case "timeout":
            return "TIMEOUT";
        default:
            return status.toUpperCase();
    }
}

/** Map transport status to display outcome (preserves flaky/timeout when provided). */
export function toDisplayOutcome(
    status: TestResult["status"],
    detail?: PlaywrightOutcomeStatus,
): PlaywrightOutcomeStatus {
    return detail ?? status;
}

/** Stable key for auto-expand/selection effects when result statuses change. */
export function buildResultStateKey(results: TestResult[]): string {
    return results.map((result) => `${result.id}:${result.status}`).join("|");
}

export function partitionResults(results: TestResult[]): {
    failed: TestResult[];
    passed: TestResult[];
    skipped: TestResult[];
} {
    const failed: TestResult[] = [];
    const passed: TestResult[] = [];
    const skipped: TestResult[] = [];
    for (const result of results) {
        if (result.status === "failed") failed.push(result);
        else if (result.status === "passed") passed.push(result);
        else skipped.push(result);
    }
    return { failed, passed, skipped };
}

/** Split a core-normalized suite breadcrumb into nested segments. */
export function splitSuitePath(suite: string): string[] {
    return suite
        .split(" > ")
        .map((segment) => segment.trim())
        .filter(Boolean);
}

/** Build a nested suite tree from flat, transport-normalized test rows. */
export function buildSuiteTree(results: TestResult[]): SuiteTreeNode[] {
    const roots: SuiteTreeNode[] = [];
    const index = new Map<string, SuiteTreeNode>();

    for (const result of results) {
        const segments = splitSuitePath(result.suite);
        if (segments.length === 0) {
            const fallback = index.get("__root__");
            if (fallback) fallback.tests.push(result);
            else {
                const node: SuiteTreeNode = {
                    name: "Tests",
                    path: "Tests",
                    children: [],
                    tests: [result],
                };
                index.set("__root__", node);
                roots.push(node);
            }
            continue;
        }

        let parentPath = "";
        let level = roots;
        for (const segment of segments) {
            parentPath = parentPath ? `${parentPath} > ${segment}` : segment;
            let node = index.get(parentPath);
            if (!node) {
                node = { name: segment, path: parentPath, children: [], tests: [] };
                index.set(parentPath, node);
                level.push(node);
            }
            level = node.children;
        }

        const leafPath = segments.join(" > ");
        const leaf = index.get(leafPath);
        if (leaf) leaf.tests.push(result);
    }

    return roots;
}

/** Flatten a suite tree back into render order (depth-first, tests after children). */
export function flattenSuiteTree(nodes: SuiteTreeNode[]): TestResult[] {
    const ordered: TestResult[] = [];
    const walk = (node: SuiteTreeNode) => {
        for (const child of node.children) walk(child);
        ordered.push(...node.tests);
    };
    for (const node of nodes) walk(node);
    return ordered;
}

export function categorizeArtifacts(results: TestResult[]): CategorizedArtifacts {
    const all: CategorizedArtifact[] = results.flatMap((result) =>
        (result.attachments ?? []).map((attachment) => ({
            ...attachment,
            testName: result.name,
            testStatus: result.status,
        })),
    );

    const screenshots = all.filter((artifact) => artifact.contentType?.startsWith("image/"));
    const videos = all.filter((artifact) => artifact.contentType?.includes("video"));
    const traces = all.filter((artifact) => artifact.name?.includes("trace"));
    const other = all.filter(
        (artifact) =>
            !artifact.contentType?.startsWith("image/") &&
            !artifact.contentType?.includes("video") &&
            !artifact.name?.includes("trace"),
    );

    return { all, screenshots, videos, traces, other };
}
