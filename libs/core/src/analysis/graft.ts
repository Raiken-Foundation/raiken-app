import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphEdge, ParsedSymbol, SymbolKind } from "../types";

/**
 * The code graph, produced by graft.
 *
 * graft (`@nanonets/graft`) parses the project with tree-sitter — scope-aware
 * call and import resolution for TS/JS, Python, Go, Java, Kotlin, PHP, Swift,
 * R, plus symbol-level coverage of ~15 more languages — and writes the result
 * to `wiring.json`. It is deterministic, calls no model, and rebuilds
 * incrementally (content-hash cache), so re-running it after every change is
 * cheap. Raiken reads that graph instead of maintaining its own parser for
 * symbols and cross-file edges.
 *
 * graft runs as a subprocess, never in-process: its native grammar addons stay
 * out of Raiken's process, and a grammar that fails to load degrades to
 * "graph unavailable" instead of crashing the CLI or the dashboard server.
 */

/** A node of graft's `wiring.json` (schema v1) — only the fields Raiken reads. */
export interface GraftNode {
    id: string;
    name: string;
    kind: string;
    path: string;
    span: string;
    signature: string | null;
    exported: boolean;
    owner?: string;
}

export interface GraftEdge {
    source: string;
    target: string;
    relation: string;
    confidence: string;
}

export interface GraftWiring {
    meta?: { version?: number };
    nodes: GraftNode[];
    edges: GraftEdge[];
}

/** The graph could not be built or read; `reason` says why and how to fix it. */
export class CodeGraphUnavailableError extends Error {
    constructor(readonly reason: string) {
        super(`Code graph unavailable: ${reason}`);
        this.name = "CodeGraphUnavailableError";
    }
}

/** Where Raiken keeps graft's graph — inside `.raiken/`, never the user's tree. */
export function graftDirFor(root: string): string {
    return path.join(root, ".raiken", "graft");
}

export function graftWiringPath(root: string): string {
    return path.join(graftDirFor(root), ".graph", "wiring.json");
}

let cachedBin: string | null = null;

/** The bundled graft CLI entry point. */
export function graftBinPath(): string {
    if (cachedBin) return cachedBin;
    const pkg = require.resolve("@nanonets/graft/package.json");
    const manifest = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { bin?: Record<string, string> };
    const rel = manifest.bin?.["graft"] ?? "dist/cli.js";
    cachedBin = path.join(path.dirname(pkg), rel);
    return cachedBin;
}

/**
 * Environment for every graft run. Raiken is local-first, so graft's usage
 * ping is off, and graft must not edit the user's repo: the graph lives under
 * `.raiken/` (already gitignored by `raiken init`), and graft's own
 * `.gitignore`/`.ignore` edits are disabled.
 */
function graftEnv(root: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DO_NOT_TRACK: "1",
        GRAFT_NO_GITIGNORE: "1",
        GRAFT_NO_IGNORE: "1",
        GRAFT_NO_STATUSLINE: "1",
        GRAFT_DIR: graftDirFor(root),
    };
}

const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * Build (or incrementally refresh) the graph for `root`. Unchanged files are
 * replayed from graft's cache, so a refresh after one edit costs about a
 * second on a mid-sized repo.
 */
export function buildGraftGraph(root: string, options: { timeoutMs?: number } = {}): Promise<void> {
    let bin: string;
    try {
        bin = graftBinPath();
    } catch {
        return Promise.reject(
            new CodeGraphUnavailableError(
                "the @nanonets/graft package is not installed — reinstall Raiken (`npm i -g raiken`)",
            ),
        );
    }
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [bin, "build", root],
            {
                cwd: root,
                env: graftEnv(root),
                timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
                maxBuffer: 64 * 1024 * 1024,
            },
            (error, _stdout, stderr) => {
                if (!error) return resolve();
                reject(new CodeGraphUnavailableError(describeBuildFailure(error, String(stderr))));
            },
        );
    });
}

function describeBuildFailure(error: Error & { killed?: boolean }, stderr: string): string {
    if (error.killed) return "graft build timed out";
    const nativeMissing = stderr.match(/No native build was found[^\n]*\n\s*loaded from: ([^\n]+)/);
    if (nativeMissing) {
        const grammar = path.basename(nativeMissing[1].trim());
        return (
            `the ${grammar} parser has no prebuilt binary for this platform and was not compiled on install. ` +
            "Install a C/C++ toolchain (Xcode Command Line Tools, build-essential, or Visual Studio Build Tools) " +
            "and reinstall Raiken"
        );
    }
    const lastLine = stderr.trim().split("\n").filter(Boolean).pop();
    return lastLine ? `graft build failed: ${lastLine}` : `graft build failed: ${error.message}`;
}

export function readGraftWiring(root: string): GraftWiring {
    const file = graftWiringPath(root);
    let raw: string;
    try {
        raw = fs.readFileSync(file, "utf-8");
    } catch {
        throw new CodeGraphUnavailableError(
            `no graph at ${path.relative(root, file)} — run \`raiken index\``,
        );
    }
    const parsed = JSON.parse(raw) as GraftWiring;
    if (parsed.meta?.version !== undefined && parsed.meta.version !== 1) {
        throw new CodeGraphUnavailableError(
            `unsupported graph schema v${parsed.meta.version} (Raiken reads v1) — the bundled graft and Raiken are out of sync`,
        );
    }
    return parsed;
}

// ==========================================================================
// The index Raiken queries
// ==========================================================================

/** Edge trust: graft's provenance tiers mapped onto Raiken's 0..1 confidence. */
const CONFIDENCE: Record<string, number> = {
    lsp_resolved: 1.0,
    extracted: 0.9,
    lsp_dispatch: 0.8,
    inferred: 0.7,
};

/**
 * A `references` edge names a symbol without calling it — for a PascalCase
 * target in a JSX file that is a component render; otherwise a value
 * reference (a callback, a class used as a type). Weaker than a call either way.
 */
const REFERENCE_DISCOUNT = 0.7;

const JSX_FILE = /\.(tsx|jsx)$/i;

/** graft node kinds that are symbols Raiken persists (files and variables are not). */
const KIND_MAP: Record<string, SymbolKind> = {
    function: "function",
    method: "method",
    class: "class",
    struct: "class",
    interface: "interface",
    trait: "interface",
    type: "type",
    enum: "enum",
};

export class GraftIndex {
    readonly root: string;
    private readonly nodeById = new Map<string, GraftNode>();
    private readonly symbolsByFile = new Map<string, GraftNode[]>();
    private readonly fileImports = new Map<string, Set<string>>();
    private readonly unresolvedImports = new Map<string, Set<string>>();
    private readonly symbolEdges = new Map<string, GraphEdge[]>();
    private readonly dependents = new Map<string, Set<string>>();
    private readonly indexed = new Set<string>();

    constructor(root: string, wiring: GraftWiring) {
        this.root = path.resolve(root);
        this.ingest(wiring);
    }

    /** Refresh the graph for `root`, then load it. */
    static async load(
        root: string,
        options: { refresh?: boolean; timeoutMs?: number } = {},
    ): Promise<GraftIndex> {
        const resolved = path.resolve(root);
        if (options.refresh !== false) await buildGraftGraph(resolved, options);
        return new GraftIndex(resolved, readGraftWiring(resolved));
    }

    /** Every file the graph indexed (absolute paths). */
    indexedFiles(): ReadonlySet<string> {
        return this.indexed;
    }

    has(file: string): boolean {
        return this.indexed.has(path.resolve(file));
    }

    /** Symbols declared in a file, as Raiken's `ParsedSymbol`. */
    symbolsFor(file: string): ParsedSymbol[] {
        const nodes = this.symbolsByFile.get(path.resolve(file)) ?? [];
        const out: ParsedSymbol[] = [];
        for (const node of nodes) {
            const kind = symbolKind(node);
            if (!kind) continue;
            const [startLine, endLine] = parseSpan(node.span);
            out.push({
                name: node.name,
                kind,
                startLine,
                endLine,
                isExported: node.exported,
                isAsync: node.signature
                    ? /^(export\s+)?(default\s+)?async\b/.test(node.signature)
                    : undefined,
                signature: node.signature ?? undefined,
                parent: node.owner,
            });
        }
        return out;
    }

    /** Files this file imports that graft resolved (absolute paths). */
    importsFor(file: string): string[] {
        return Array.from(this.fileImports.get(path.resolve(file)) ?? []);
    }

    /**
     * Import specifiers graft could not resolve to a file — package imports,
     * and path aliases (`@/components/x`), which graft does not read from
     * tsconfig/bundler config. Callers resolve the aliases themselves.
     */
    unresolvedImportsFor(file: string): string[] {
        return Array.from(this.unresolvedImports.get(path.resolve(file)) ?? []);
    }

    /** Symbol-level edges out of a file (calls, extends, implements, renders). */
    edgesFor(file: string): GraphEdge[] {
        return this.symbolEdges.get(path.resolve(file)) ?? [];
    }

    /** Files that import, call, or reference something in `file`. */
    dependentsOf(file: string): ReadonlySet<string> {
        return this.dependents.get(path.resolve(file)) ?? new Set();
    }

    /** File-level reverse dependency map (for impact walks). */
    dependentsMap(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.dependents;
    }

    /**
     * Record a file-level dependency graft missed (an alias import the caller
     * resolved), so impact walks see it too.
     */
    addFileDependency(from: string, to: string): void {
        const source = path.resolve(from);
        const target = path.resolve(to);
        if (source === target) return;
        addTo(this.fileImports, source, target);
        addTo(this.dependents, target, source);
    }

    private abs(rel: string): string {
        return path.join(this.root, rel);
    }

    private ingest(wiring: GraftWiring): void {
        for (const node of wiring.nodes) {
            this.nodeById.set(node.id, node);
            const file = this.abs(node.path);
            this.indexed.add(file);
            if (node.kind === "file") continue;
            const list = this.symbolsByFile.get(file) ?? [];
            list.push(node);
            this.symbolsByFile.set(file, list);
        }

        for (const edge of wiring.edges) {
            if (edge.relation === "contains") continue;
            const source = this.nodeById.get(edge.source);
            if (!source) continue;
            const sourceFile = this.abs(source.path);
            const target = this.nodeById.get(edge.target);

            if (edge.relation === "imports") {
                if (target) {
                    const targetFile = this.abs(target.path);
                    if (targetFile !== sourceFile) {
                        addTo(this.fileImports, sourceFile, targetFile);
                        addTo(this.dependents, targetFile, sourceFile);
                    }
                } else {
                    addTo(this.unresolvedImports, sourceFile, edge.target);
                }
                continue;
            }

            if (!target) continue;
            const targetFile = this.abs(target.path);
            if (targetFile !== sourceFile) addTo(this.dependents, targetFile, sourceFile);

            const graphEdge = toGraphEdge(edge, source, target, sourceFile, targetFile);
            if (!graphEdge) continue;
            const list = this.symbolEdges.get(sourceFile) ?? [];
            list.push(graphEdge);
            this.symbolEdges.set(sourceFile, list);
        }
    }
}

function toGraphEdge(
    edge: GraftEdge,
    source: GraftNode,
    target: GraftNode,
    sourceFile: string,
    targetFile: string,
): GraphEdge | null {
    const base = CONFIDENCE[edge.confidence] ?? 0.7;
    const [line] = parseSpan(source.span);
    const common = {
        sourceFile,
        targetFile,
        sourceSymbol: source.kind === "file" ? undefined : source.name,
        targetSymbol: target.kind === "file" ? undefined : target.name,
        provenance: "static_ast" as const,
    };
    switch (edge.relation) {
        case "calls":
            return {
                ...common,
                kind: "calls",
                confidence: base,
                evidence: { line, snippet: `${target.name}(...)` },
            };
        case "extends":
        case "implements":
            return { ...common, kind: edge.relation, confidence: base, evidence: { line } };
        case "references": {
            const renders = JSX_FILE.test(target.path) && /^[A-Z]/.test(target.name);
            return {
                ...common,
                kind: renders ? "renders" : "calls",
                confidence: base * REFERENCE_DISCOUNT,
                evidence: {
                    line,
                    snippet: renders ? `<${target.name} />` : target.name,
                    note: "reference",
                },
            };
        }
        default:
            return null;
    }
}

function symbolKind(node: GraftNode): SymbolKind | null {
    const kind = KIND_MAP[node.kind];
    if (!kind) return null;
    // A PascalCase function in a JSX file is a React component — the kind
    // Raiken's context and cover flows look for.
    if (kind === "function" && JSX_FILE.test(node.path) && /^[A-Z]/.test(node.name))
        return "component";
    return kind;
}

/** "L165-L222" → [165, 222]. */
function parseSpan(span: string): [number, number] {
    const m = span.match(/^L(\d+)(?:-L(\d+))?$/);
    if (!m) return [0, 0];
    const start = Number(m[1]);
    return [start, m[2] ? Number(m[2]) : start];
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    let set = map.get(key);
    if (!set) {
        set = new Set();
        map.set(key, set);
    }
    set.add(value);
}
