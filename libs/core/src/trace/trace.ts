/**
 * Reverse query: given a stack trace from a production incident, return the
 * existing tests in the graph that most directly cover the implicated code.
 *
 * The mental model: an incident's stack trace tells you which symbols ran
 * when things broke. Our graph already knows which tests touch those
 * symbols. So the answer to "which tests should reproduce this?" is just a
 * `getAffectedTests` over the files we extract from the trace.
 *
 * The parser is deliberately tolerant: V8, Node, browser, and Playwright
 * traces all use slightly different conventions, but the bit we care about
 * — the file path with optional `:line:column` — is consistent enough to
 * grab with a small regex set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type AffectedTestEvidence, GraphQueryService } from "../analysis/graph-query";

export interface TraceFrame {
    /** Function/symbol name if extractable. */
    symbol?: string;
    /** Path as it appears in the trace. */
    rawPath: string;
    /** Path resolved into the project, if it lives inside the project. */
    resolvedPath?: string;
    line?: number;
    column?: number;
}

export interface TraceQueryOptions {
    projectPath: string;
    /** The raw stack trace text. */
    trace: string;
    /** Confidence floor for returned matches (default: 0). */
    minConfidence?: number;
    /** Maximum tests to return (default: 20). */
    limit?: number;
}

export interface TraceMatch {
    testFile: string;
    confidence: number;
    /** Source files from the trace that contributed to this match. */
    matchedFrames: string[];
    evidence: AffectedTestEvidence[];
}

export interface TraceResult {
    frames: TraceFrame[];
    /** Frames that were resolved to a project file. */
    projectFrames: TraceFrame[];
    matches: TraceMatch[];
}

/**
 * Frame parsers. Each entry takes a trimmed trace line and either returns a
 * frame or null. We try them in order and keep the first match.
 *
 * Patterns covered:
 *   1. V8/Node:           "at fnName (path/to/file.ts:12:34)"
 *   2. V8/Node anonymous: "at path/to/file.ts:12:34"
 *   3. Bare path:         "path/to/file.ts:12:34"
 *   4. Browser/Webkit:    "fnName@path/to/file.ts:12:34"
 */
const FRAME_PATTERNS: Array<(line: string) => TraceFrame | null> = [
    // V8/Node, parenthesised:  "at <symbol> (<path>:<line>:<col>)"
    // `<symbol>` can contain spaces ("async Foo.<anonymous>") and dots, so
    // we use a non-greedy any-but-"(" match and rely on the trailing paren
    // group + end-anchor to disambiguate.
    (line) => {
        const m = /^\s*at\s+(.+?)\s+\(([^)]+?)(?::(\d+))?(?::(\d+))?\)\s*$/.exec(line);
        if (!m) return null;
        return {
            symbol: m[1],
            rawPath: m[2],
            line: m[3] ? Number(m[3]) : undefined,
            column: m[4] ? Number(m[4]) : undefined,
        };
    },
    // V8/Node, anonymous:  "at <path>:<line>:<col>"
    (line) => {
        const m = /^\s*at\s+([^\s(]+?)(?::(\d+))?(?::(\d+))?\s*$/.exec(line);
        if (!m) return null;
        // Heuristic: if the captured token looks like a path, treat as such.
        if (!/[/\\.]/.test(m[1])) return null;
        return {
            rawPath: m[1],
            line: m[2] ? Number(m[2]) : undefined,
            column: m[3] ? Number(m[3]) : undefined,
        };
    },
    // Firefox/Webkit:  "<symbol>@<path>:<line>:<col>"
    // `<path>` may contain `:` (e.g. "http://..."), so the path capture is
    // non-greedy and `:<line>(:<col>)?$` is required at the end.
    (line) => {
        const m = /^([^\s@()]+)@(.+?):(\d+)(?::(\d+))?\s*$/.exec(line);
        if (!m) return null;
        return {
            symbol: m[1],
            rawPath: m[2],
            line: Number(m[3]),
            column: m[4] ? Number(m[4]) : undefined,
        };
    },
    // Bare path + line:col — only applied last so it doesn't cannibalise
    // more specific patterns. The extension-like suffix limits false matches.
    (line) => {
        const m = /^([^\s:]+?\.[a-zA-Z]{1,5}):(\d+)(?::(\d+))?\s*$/.exec(line);
        if (!m) return null;
        return {
            rawPath: m[1],
            line: Number(m[2]),
            column: m[3] ? Number(m[3]) : undefined,
        };
    },
];

export function parseTrace(trace: string): TraceFrame[] {
    const frames: TraceFrame[] = [];
    for (const rawLine of trace.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        for (const parser of FRAME_PATTERNS) {
            const frame = parser(line);
            if (frame) {
                frames.push(frame);
                break;
            }
        }
    }
    return frames;
}

/**
 * Resolve a frame's `rawPath` into a project-relative path if the file
 * exists inside the project. Strips common URL prefixes (file://) and
 * source-map suffixes.
 */
function resolveFrame(frame: TraceFrame, projectPath: string): TraceFrame {
    let candidate = frame.rawPath;
    candidate = candidate.replace(/^file:\/\//, "");
    // Strip query strings & hashes that bundlers sometimes append.
    candidate = candidate.replace(/[?#].*$/, "");
    // Webpack-style "webpack:///" + project root prefixes.
    candidate = candidate.replace(/^webpack:\/+/, "");

    // Resolve symlinks on both ends; on macOS `process.cwd()` typically
    // returns the canonical path (`/private/tmp/...`) while trace frames
    // report the user-level path (`/tmp/...`), and a naive `path.relative`
    // would produce a "../.." path that we'd then reject as escaping the
    // project. Canonicalising both sides avoids that.
    const canonicalProject = safeRealpath(projectPath);
    const tryAbs = (p: string): string | null => {
        try {
            const real = fs.realpathSync(p);
            const st = fs.statSync(real);
            return st.isFile() ? real : null;
        } catch {
            return null;
        }
    };

    const candidates: string[] = [];
    if (path.isAbsolute(candidate)) {
        candidates.push(candidate);
    } else {
        candidates.push(path.resolve(projectPath, candidate));
    }
    // Some traces report paths relative to the package root (e.g. "src/...");
    // also try common subroots in monorepos.
    for (const root of ["", "src", "apps", "libs", "packages"]) {
        candidates.push(path.resolve(projectPath, root, candidate));
    }

    for (const abs of candidates) {
        const found = tryAbs(abs);
        if (!found) continue;
        const rel = path.relative(canonicalProject, found);
        // Reject paths that escape the project (e.g. node_modules siblings).
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
        return { ...frame, resolvedPath: rel };
    }
    return frame;
}

function safeRealpath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return p;
    }
}

export async function queryTrace(options: TraceQueryOptions): Promise<TraceResult> {
    const projectPath = path.resolve(options.projectPath);
    const minConfidence = options.minConfidence ?? 0;
    const limit = options.limit ?? 20;

    const frames = parseTrace(options.trace).map((f) => resolveFrame(f, projectPath));
    const projectFrames = frames.filter((f) => !!f.resolvedPath);

    if (projectFrames.length === 0) {
        return { frames, projectFrames, matches: [] };
    }

    // De-dupe source files; preserve order so the topmost frame keeps priority.
    const uniqueSourceFiles: string[] = [];
    const seen = new Set<string>();
    for (const f of projectFrames) {
        if (!f.resolvedPath || seen.has(f.resolvedPath)) continue;
        seen.add(f.resolvedPath);
        uniqueSourceFiles.push(f.resolvedPath);
    }

    const query = new GraphQueryService(projectPath);
    const evidence = query.getAffectedTests(uniqueSourceFiles);

    // Aggregate: best confidence per (testFile, sourceFile) pair, then per testFile.
    const byTest = new Map<string, AffectedTestEvidence[]>();
    for (const row of evidence) {
        const list = byTest.get(row.testFile) ?? [];
        list.push(row);
        byTest.set(row.testFile, list);
    }

    const matches: TraceMatch[] = [];
    for (const [testFile, rows] of byTest) {
        const confidence = rows.reduce((acc, r) => Math.max(acc, r.confidence), 0);
        if (confidence < minConfidence) continue;
        matches.push({
            testFile,
            confidence,
            matchedFrames: Array.from(new Set(rows.map((r) => r.sourceFile))),
            evidence: rows,
        });
    }

    matches.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        // Tie-break: more matched frames is a stronger signal than alphabetic.
        if (b.matchedFrames.length !== a.matchedFrames.length) {
            return b.matchedFrames.length - a.matchedFrames.length;
        }
        return a.testFile.localeCompare(b.testFile);
    });

    return { frames, projectFrames, matches: matches.slice(0, limit) };
}
