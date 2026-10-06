import * as fs from "node:fs";
import * as path from "node:path";
import { CodeGraph } from "../analysis/code-graph";
import {
    type AffectedTestEvidence,
    GraphQueryService,
    isLikelyTestPath,
} from "../analysis/graph-query";
import { loadTestDirectory } from "../config/load";
import {
    type DependentsGraph,
    dependentsFromIndex,
    extractRouteBindings,
    factPath,
    type RouteBinding,
    reverseReach,
    routeMatches,
    routesReachedBy,
} from "../contract/impact";
import type { CiAffectedTest, CiChangedFile, CiSelection } from "./types";

/**
 * Which tests does a diff affect — and can we prove it?
 *
 * Evidence, strongest first:
 *   - a changed spec (affected by definition)
 *   - recorded links: test_source_map, runtime edges (from the index)
 *   - code: the spec imports/calls the changed code, transitively (graft graph)
 *   - routes: the spec visits a route whose component chain reaches the
 *     changed code — how an E2E spec, which imports no app code, connects to it
 *
 * The selector fails safe. A changed source file that no evidence connects to
 * a test at or above the confidence threshold cannot be proven harmless, so
 * the whole suite runs instead ("full"), with the unmapped files named. So
 * does a change to a global file (config, styles, markup shell), and any run
 * where the code graph is unavailable. Running nothing is reserved for diffs
 * with no source changes at all.
 */

export interface SelectTestsInput {
    projectPath: string;
    changedFiles: CiChangedFile[];
    confidenceThreshold: number;
    /** What to do when the impact cannot be proven. Default "full". */
    fallback?: "full" | "none";
}

export interface SelectTestsResult {
    affectedTests: CiAffectedTest[];
    skippedBelowThreshold: Array<{ testFile: string; confidence: number }>;
    selection: CiSelection;
}

/** Injectable sources, so the policy is testable without git, a DB, or graft. */
export interface SelectTestsSources {
    loadGraph: (projectPath: string) => Promise<{ graph: DependentsGraph | null; reason?: string }>;
    recordedEvidence: (projectPath: string, changedSourceFiles: string[]) => AffectedTestEvidence[];
    listSpecFiles: (projectPath: string) => string[];
    routeBindings: (projectPath: string) => RouteBinding[];
}

const defaultSources: SelectTestsSources = {
    loadGraph: async (projectPath) => {
        const codeGraph = new CodeGraph(projectPath);
        const index = await codeGraph.loadDependencyGraph();
        return index
            ? { graph: dependentsFromIndex(index) }
            : { graph: null, reason: codeGraph.getGraphStatus().reason };
    },
    recordedEvidence: (projectPath, files) =>
        new GraphQueryService(projectPath).getAffectedTests(files),
    listSpecFiles: listSuiteSpecFiles,
    routeBindings: extractRouteBindings,
};

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|py|go|java|kt|php|rb|rs|cs|swift)$/i;
const GLOBAL_FILE =
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|playwright\.config\.[cm]?[jt]s|raiken\.config\.json|index\.html|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?js|tsconfig\.json)$|\.(css|scss|sass|less)$/i;

const CONFIDENCE = {
    directImport: 0.85,
    transitiveImport: 0.7,
    route: 0.8,
};

export async function selectAffectedTests(
    input: SelectTestsInput,
    sources: SelectTestsSources = defaultSources,
): Promise<SelectTestsResult> {
    const { projectPath, confidenceThreshold } = input;
    const fallback = input.fallback ?? "full";
    const abs = (rel: string) => path.resolve(projectPath, rel);
    const toRel = (file: string) =>
        (path.isAbsolute(file) ? path.relative(projectPath, file) : file).split(path.sep).join("/");

    const present = input.changedFiles.filter((f) => f.status !== "removed");
    const changedTests = directlyChangedTests(input.changedFiles);
    const sourceChanges = present
        .map((f) => f.path)
        .filter((p) => !isLikelyTestPath(p) && (CODE_FILE.test(p) || GLOBAL_FILE.test(p)));
    // A deleted source file still changes behavior for whatever imported it.
    const removedSources = input.changedFiles
        .filter(
            (f) => f.status === "removed" && CODE_FILE.test(f.path) && !isLikelyTestPath(f.path),
        )
        .map((f) => f.path);

    const full = (
        reason: string,
        graph: CiSelection["graph"],
        unmapped: string[] = [],
    ): SelectTestsResult => {
        if (fallback === "none") {
            return {
                affectedTests: changedTests,
                skippedBelowThreshold: [],
                selection: {
                    mode: "impact",
                    reason: `${reason} — fallback disabled, running only changed specs`,
                    graph,
                    unmapped,
                },
            };
        }
        const specs = sources.listSpecFiles(projectPath);
        return {
            affectedTests: specs.map((testFile) => ({
                testFile,
                confidence: 1,
                sourceFiles: unmapped,
                reasons: [
                    {
                        reason: "fallback",
                        provenance: "inferred",
                        confidence: 1,
                        sourceFile: unmapped[0] ?? "",
                    },
                ],
            })),
            skippedBelowThreshold: [],
            selection: { mode: "full", reason, graph, unmapped },
        };
    };

    if (sourceChanges.length === 0 && removedSources.length === 0) {
        return {
            affectedTests: changedTests,
            skippedBelowThreshold: [],
            selection: {
                mode: changedTests.length > 0 ? "impact" : "none",
                reason:
                    changedTests.length > 0
                        ? "only test files changed"
                        : "no source files changed (docs, assets, or tests removed only)",
                graph: { available: true },
                unmapped: [],
            },
        };
    }

    const globalChange = sourceChanges.find((p) => GLOBAL_FILE.test(p));
    const { graph, reason: graphReason } = await sources.loadGraph(projectPath);
    const graphStatus: CiSelection["graph"] = graph
        ? { available: true }
        : { available: false, reason: graphReason ?? "the code graph could not be built" };
    if (globalChange) return full(`${globalChange} changed (affects every test)`, graphStatus);
    if (!graph) return full(`impact cannot be computed: ${graphStatus.reason}`, graphStatus);

    const codeChanges = sourceChanges.filter((p) => CODE_FILE.test(p));

    // file::test → evidence row
    const evidence = new Map<
        string,
        { testFile: string; sourceFile: string; reasons: CiAffectedTest["reasons"] }
    >();
    const add = (
        testFile: string,
        sourceFile: string,
        reason: CiAffectedTest["reasons"][number],
    ) => {
        const key = `${testFile}::${sourceFile}`;
        const row = evidence.get(key) ?? { testFile, sourceFile, reasons: [] };
        row.reasons.push(reason);
        evidence.set(key, row);
    };

    // 1. Recorded links from the index. Graph tables key files by absolute
    // path and test_source_map by project-relative path: ask with both.
    const recorded = sources.recordedEvidence(projectPath, [
        ...codeChanges,
        ...removedSources,
        ...codeChanges.map(abs),
        ...removedSources.map(abs),
    ]);
    for (const row of recorded) {
        const testFile = toRel(row.testFile);
        const sourceFile = toRel(row.sourceFile);
        for (const reason of row.reasons) {
            add(testFile, sourceFile, {
                reason: reason.reason,
                provenance: reason.provenance === "test_run" ? "runtime" : reason.provenance,
                confidence: reason.confidence,
                sourceFile,
                sourceSymbol: reason.sourceSymbol,
                targetSymbol: reason.targetSymbol,
                line: reason.line,
                snippet: reason.snippet,
            });
        }
    }

    // 2. Code: tests that depend on the changed file, directly or transitively.
    for (const rel of codeChanges) {
        const trail = reverseReach(graph, abs(rel));
        for (const [file, predecessor] of trail) {
            const testFile = toRel(file);
            if (predecessor === null || !isLikelyTestPath(testFile)) continue;
            const direct = predecessor === abs(rel);
            add(testFile, rel, {
                reason: "imports",
                provenance: "static_ast",
                confidence: direct ? CONFIDENCE.directImport : CONFIDENCE.transitiveImport,
                sourceFile: rel,
                snippet: direct ? undefined : chain(trail, file).map(toRel).join(" → "),
            });
        }
    }

    // 3. Routes: E2E specs reach app code through the URLs they visit.
    const bindings = sources.routeBindings(projectPath);
    if (bindings.length > 0) {
        const visits = sources
            .listSpecFiles(projectPath)
            .map((spec) => ({ spec, paths: visitedPaths(abs(spec)) }))
            .filter((v) => v.paths.length > 0);
        for (const rel of codeChanges) {
            const reached = routesReachedBy(abs(rel), bindings, graph);
            for (const [pattern, via] of reached) {
                for (const { spec, paths } of visits) {
                    const visited = paths.find((p) => routeMatches(pattern, p));
                    if (!visited) continue;
                    add(spec, rel, {
                        reason: "route",
                        provenance: "static_ast",
                        confidence: CONFIDENCE.route,
                        sourceFile: rel,
                        snippet: `goto('${visited}') → ${pattern} ← ${via.map(toRel).join(" ← ")}`,
                    });
                }
            }
        }
    }

    // Collapse per test file; a source change counts as mapped only when some
    // test clears the threshold for it.
    const byTest = new Map<string, CiAffectedTest>();
    const provenSources = new Set<string>();
    for (const row of evidence.values()) {
        const confidence = Math.max(...row.reasons.map((r) => r.confidence));
        if (confidence >= confidenceThreshold) provenSources.add(row.sourceFile);
        const existing = byTest.get(row.testFile);
        if (existing) {
            existing.confidence = Math.max(existing.confidence, confidence);
            if (!existing.sourceFiles.includes(row.sourceFile))
                existing.sourceFiles.push(row.sourceFile);
            existing.reasons.push(...row.reasons);
        } else {
            byTest.set(row.testFile, {
                testFile: row.testFile,
                confidence,
                sourceFiles: [row.sourceFile],
                reasons: [...row.reasons],
            });
        }
    }

    const unmapped = [...codeChanges, ...removedSources].filter((p) => !provenSources.has(p));
    if (unmapped.length > 0) {
        return full(
            `${unmapped.length} changed source file(s) reach no test with confidence ≥ ${confidenceThreshold}: ${unmapped.join(", ")}`,
            graphStatus,
            unmapped,
        );
    }

    const affectedTests: CiAffectedTest[] = [];
    const skippedBelowThreshold: Array<{ testFile: string; confidence: number }> = [];
    for (const test of byTest.values()) {
        if (test.confidence >= confidenceThreshold) affectedTests.push(test);
        else skippedBelowThreshold.push({ testFile: test.testFile, confidence: test.confidence });
    }
    const accepted = new Set(affectedTests.map((t) => t.testFile));
    for (const entry of changedTests) {
        if (accepted.has(entry.testFile)) continue;
        accepted.add(entry.testFile);
        affectedTests.push(entry);
    }

    return {
        affectedTests,
        skippedBelowThreshold: skippedBelowThreshold.filter((s) => !accepted.has(s.testFile)),
        selection: {
            mode: "impact",
            reason: `every changed source file reaches at least one test (threshold ${confidenceThreshold})`,
            graph: graphStatus,
            unmapped: [],
        },
    };
}

/**
 * Changed files that are themselves test files, expressed as affected-test
 * entries with maximum confidence. Deletions drop out (nothing to run);
 * renames count under their new path.
 */
export function directlyChangedTests(changedFiles: CiChangedFile[]): CiAffectedTest[] {
    const entries: CiAffectedTest[] = [];
    const seen = new Set<string>();
    for (const file of changedFiles) {
        if (file.status === "removed") continue;
        if (!isLikelyTestPath(file.path)) continue;
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        entries.push({
            testFile: file.path,
            confidence: 1.0,
            sourceFiles: [file.path],
            reasons: [
                {
                    reason: "changed_test",
                    provenance: "static_ast",
                    confidence: 1.0,
                    sourceFile: file.path,
                },
            ],
        });
    }
    return entries;
}

/**
 * URL paths a spec navigates to: string-literal `goto(...)` targets, as paths
 * (absolute URLs reduced to their pathname). Dynamic targets are not guessed —
 * a spec with none simply gets no route evidence.
 */
export function visitedPaths(specFile: string): string[] {
    let source: string;
    try {
        source = fs.readFileSync(specFile, "utf-8");
    } catch {
        return [];
    }
    const out = new Set<string>();
    for (const m of source.matchAll(/\.goto\(\s*(['"`])([^'"`$]*)\1/g)) {
        const target = m[2].trim();
        if (!target) continue;
        if (/^https?:\/\//i.test(target) || target.startsWith("/")) out.add(factPath(target));
    }
    return Array.from(out);
}

/** Spec files in the configured test directory (project-relative). */
export function listSuiteSpecFiles(projectPath: string): string[] {
    const testDirectory = loadTestDirectory(projectPath);
    const root = path.resolve(projectPath, testDirectory);
    const out: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (
                /\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(entry.name) &&
                !/\.raiken-run-\d+\.spec\.(ts|tsx|js|jsx)$/.test(entry.name)
            ) {
                out.push(path.relative(projectPath, full).split(path.sep).join("/"));
            }
        }
    };
    walk(root);
    return out.sort();
}

function chain(trail: Map<string, string | null>, from: string): string[] {
    const out: string[] = [];
    let cur: string | null | undefined = from;
    while (cur) {
        out.push(cur);
        cur = trail.get(cur);
    }
    return out.reverse();
}
