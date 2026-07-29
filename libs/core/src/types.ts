// ============================================================================
// AST Types (Used by ast-parser.ts and code-graph.ts)
// ============================================================================

export interface ParsedFunction {
    name: string;
    params: string[];
    returnType?: string;
    isAsync: boolean;
    isExported: boolean;
    line: number;
}

export interface ParsedClass {
    name: string;
    methods: string[];
    properties: string[];
    isExported: boolean;
    line: number;
}

export interface ParsedImport {
    source: string;
    defaultImport?: string;
    namespaceImport?: string;
    namedImports: string[];
    isTypeOnly?: boolean;
}

export interface ParsedType {
    name: string;
    kind: "type" | "interface" | "enum";
    isExported: boolean;
    line: number;
}

/**
 * A locator-shaped fact read out of markup in the repository.
 *
 * Only literal attribute values are recorded. `data-testid="{{ id }}"` and
 * `:data-testid="row.id"` are computed at render time, so treating them as
 * selectors would hand the model a string that never appears in a real page.
 */
export interface TemplateSelector {
    /** How Playwright would address the element this came from. */
    kind: "testId" | "label" | "placeholder" | "role";
    value: string;
    /** Which attribute supplied a `testId` (projects vary: `data-test`, `data-cy`, …). */
    attribute?: string;
    line: number;
}

export interface ParsedFile {
    functions: ParsedFunction[];
    classes: ParsedClass[];
    imports: ParsedImport[];
    exports: string[];
    types: ParsedType[];
    /**
     * Selectors found in this file's markup — a component template, or a
     * server-rendered template in a repo whose backend we cannot parse at all.
     * Optional because the field post-dates persisted indexes.
     */
    templateSelectors?: TemplateSelector[];
}

export interface ParsedFileWithAst {
    parsed: ParsedFile; // Simplified structure for embeddings
    ast: unknown; // Complete Babel AST for test generation
}

// ============================================================================
// Code Chunks (Used for embeddings generation)
// ============================================================================

export interface CodeChunk {
    type: "function" | "class" | "type" | "file";
    name: string;
    filePath: string;
    data: ParsedFunction | ParsedClass | ParsedType | null;
    // Metadata for context
    line?: number;
    isExported?: boolean;
    isAsync?: boolean;
}

// ============================================================================
// Entry Point Detector
// ============================================================================

export interface EntryPointResult {
    file: string;
    type: "explicit" | "inferred" | "convention";
    framework?: string;
    reason: string;
    role?: "main" | "layout" | "page" | "api" | "middleware" | "config";
}

export interface PackageJson {
    main?: string;
    module?: string;
    browser?: string;
    exports?: Record<string, unknown> | string;
    workspaces?: string[] | { packages?: string[] };
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

export interface NextConfig {
    pageExtensions?: string[];
    experimental?: {
        appDir?: boolean;
    };
}

// ============================================================================
// Code Graph
// ============================================================================

export interface CodeNode {
    filePath: string; // Absolute path
    relativePath: string; // Relative to project root
    parsed: ParsedFile; // Simplified AST (functions, classes, imports, exports) - for embeddings
    ast?: unknown; // Complete Babel AST - for test generation
    /** Symbols extracted from the file (functions, classes, routes, ...). */
    symbols?: ParsedSymbol[];
    /** Structural edges declared inside this file (extends/implements). */
    intraFileEdges?: GraphEdge[];
    imports: string[]; // Files this imports (absolute paths)
    importedBy: string[]; // Files that import this (absolute paths)
    depth: number; // Distance from entry point
    size: number; // File size in bytes
    lines: number; // Total lines of code
    lastModified: number; // Timestamp (for change detection)
    hash: string; // Content hash (for diffing)
    treeHash: string; // Hash of this node + all descendants (for tree change detection)
    meta: {
        extension: string; // File extension (.ts, .tsx, etc.)
        isTest: boolean; // Is this a test file?
        isEntry: boolean; // Is this an entry point?
        hasExports: boolean; // Does this file export anything?
        hasDefaultExport: boolean; // Has default export?
        complexity: number; // Simple complexity metric (functions + classes)
    };
}

export interface GraphStats {
    totalFiles: number;
    totalFunctions: number;
    totalClasses: number;
    lastUpdate: Date;
}

export interface UpdateEvent {
    type: "add" | "change" | "remove";
    filePath: string;
    affectedFiles: string[];
    timestamp: Date;
}

export interface CodeGraphOptions {
    maxDepth?: number;
    extensions?: string[];
    excludeDirs?: string[];
    includeTests?: boolean;
    useGitignore?: boolean;
    enableWatch?: boolean;
    onUpdate?: (event: UpdateEvent) => void;
    /**
     * Files larger than this are skipped entirely (not read into memory or
     * parsed) — protects indexing from OOMs/hangs on accidentally-included
     * generated bundles, lockfiles, or other huge non-source files.
     * Default 2MB, which comfortably covers real hand-written source files.
     */
    maxFileSizeBytes?: number;
}

// ============================================================================
// Database Types
// ============================================================================

export interface DBFileNode {
    id: number;
    project_path: string;
    file_path: string;
    relative_path: string;
    content_hash: string;
    tree_hash: string;
    size: number;
    lines: number;
    depth: number;
    last_indexed: number;
    functions_count: number;
    classes_count: number;
    types_count: number;
    imports_count: number;
    exported_count: number;
    parsed_ast: string; // Simplified AST structure as JSON (for embeddings)
    ast: string | null; // Complete Babel AST as JSON (for test generation)
    indexed_via: "scan" | "watch"; // Track how file was indexed
}

export interface DBDependency {
    id: number;
    project_path: string;
    source_file: string;
    target_file: string;
    import_type: "static" | "dynamic" | "type-only"; // ✅ Track import type
    created_at: number;
}

export interface DBEntryPoint {
    id: number;
    project_path: string;
    file_path: string;
    framework: string | null;
    role: string;
    type: string;
    created_at: number;
}

export interface DBStats {
    project_path: string;
    total_files: number;
    total_size: number;
    total_lines: number;
    total_functions: number;
    total_classes: number;
    total_types: number;
    last_scan: number;
    schema_version: number;
}

// ============================================================================
// Symbol Graph Types
// ============================================================================

export type SymbolKind =
    | "function"
    | "arrow_function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "enum"
    | "component"
    | "route";

/**
 * A first-class symbol extracted from a file's AST.
 * Symbols are queryable units beyond the file level: a single function,
 * a class method, a route definition, etc.
 */
export interface ParsedSymbol {
    name: string;
    kind: SymbolKind;
    startLine: number;
    endLine: number;
    isExported: boolean;
    isAsync?: boolean;
    signature?: string;
    /** Name of the parent symbol (e.g. class name for methods) */
    parent?: string;
    /** Identifier names referenced inside this symbol's body */
    callees?: string[];
    /** JSX/component identifiers referenced inside this symbol's body */
    rendered?: string[];
    /** For routes: HTTP method or route framework (e.g. "GET", "page", "api") */
    routeMeta?: { method?: string; path?: string; kind: "page" | "api" | "handler" };
}

export type EdgeKind =
    | "imports"
    | "calls"
    | "extends"
    | "implements"
    | "renders"
    | "tests"
    | "defines"
    | "covers";

/**
 * Where an edge came from. Used by the query layer to weight evidence.
 */
export type EdgeProvenance =
    | "static_ast" // extracted from AST during indexing
    | "runtime" // captured during a live test run
    | "manual" // declared by user (e.g. test_source_map)
    | "inferred" // heuristically derived (semantic, naming)
    | "test_run"; // produced by an actual run / coverage data

export interface GraphEdge {
    kind: EdgeKind;
    sourceFile: string;
    targetFile: string;
    sourceSymbol?: string;
    targetSymbol?: string;
    provenance: EdgeProvenance;
    confidence: number; // 0..1
    evidence?: {
        line?: number;
        snippet?: string;
        note?: string;
    };
}
