import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import ignore, { type Ignore } from "ignore";
import type {
    CodeGraphOptions,
    CodeNode,
    GraphEdge,
    GraphStats,
    ParsedFile,
    ParsedSymbol,
    UpdateEvent,
} from "../types";
import { isBinaryFile, isTestDirectory, isTestFile } from "../utils";
import { isMarkupFile } from "./markup-selectors";
import { analyzeSourceFile } from "./source-analysis";
import { extractSymbolsFromAst } from "./symbol-extractor";

export class CodeGraph {
    private rootPath: string;
    private nodes = new Map<string, CodeNode>();
    private options: Required<Omit<CodeGraphOptions, "onUpdate" | "excludeDirs">> & {
        onUpdate?: (event: UpdateEvent) => void;
        excludeDirs?: string[];
    };
    private watcher?: FSWatcher;
    private pendingUpdates = new Map<string, NodeJS.Timeout>();
    private pathAliases: Map<string, string> = new Map();
    // Performance optimization: Cache resolved import paths and existing file checks
    private importCache = new Map<string, string[]>();
    private fileExistsCache = new Map<string, boolean>();
    private cachedKeywordIndex: Map<string, string[]> | null = null;
    /** Per-file intra-file edges (extends/implements) collected during parse. */
    private intraFileEdges = new Map<string, GraphEdge[]>();

    // Cache size limits to prevent unbounded memory growth
    private static readonly CACHE_MAX_SIZE = 5000;

    constructor(rootPath: string, options: CodeGraphOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.options = {
            maxDepth: options.maxDepth ?? 10,
            // Includes SFCs: `analyzeSourceFile` splits their `<script>` out
            // before Babel sees it, so they now produce real symbols instead of
            // an empty node. Listing them here also lets `import Foo from
            // './Foo.vue'` resolve to a graph edge.
            extensions: options.extensions ?? [
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mjs",
                ".cjs",
                ".mts",
                ".cts",
                ".vue",
                ".svelte",
            ],
            excludeDirs: options.excludeDirs,
            includeTests: options.includeTests ?? true,
            useGitignore: options.useGitignore ?? true,
            enableWatch: options.enableWatch ?? false,
            onUpdate: options.onUpdate,
            maxFileSizeBytes: options.maxFileSizeBytes ?? 2 * 1024 * 1024,
        };

        this.loadPathAliases();
    }

    /**
     * Load path aliases from config files.
     *
     * STRATEGY:
     * 1. tsconfig.json/jsconfig.json - Most authoritative, fully safe
     * 2. Bundler configs (Vite/Webpack) - Static extraction only, no execution
     * 3. Manual aliases via addPathAlias() - For complex cases
     *
     * SECURITY:
     * - No code execution (static extraction only)
     * - Validates paths don't escape project root
     * - Logs errors for debugging
     */
    private loadPathAliases(): void {
        // Priority 1: TypeScript/JavaScript compiler configs (JSON, safest)
        for (const configFile of ["tsconfig.json", "jsconfig.json"]) {
            if (this.tryLoadCompilerConfig(configFile)) {
                // Found tsconfig, but still try bundler configs for additional aliases
                break;
            }
        }

        // Priority 2: Bundler configs (static extraction, safe)
        this.tryLoadBundlerConfigs();
    }

    /**
     * Try loading bundler configs using safe static extraction.
     * Only extracts literal string values - no code execution.
     */
    private tryLoadBundlerConfigs(): void {
        const bundlerConfigs = [
            "vite.config.ts",
            "vite.config.js",
            "vite.config.mts",
            "vite.config.mjs",
            "webpack.config.ts",
            "webpack.config.js",
            "webpack.config.mjs",
        ];

        for (const configFile of bundlerConfigs) {
            this.tryLoadBundlerConfigStatic(configFile);
        }
    }

    /**
     * Statically extract path aliases from bundler configs.
     *
     * SAFE: Only extracts literal string values, no execution.
     * HANDLES:
     * - alias: { '@': './src' }
     * - alias: { '@': '/src' }
     * - resolve: { alias: { ... } }
     * - alias: [{ find: '@', replacement: './src' }]
     *
     * DOES NOT HANDLE (by design):
     * - path.resolve(__dirname, 'src') - requires execution
     * - Dynamic imports or conditionals - requires execution
     * - Variables - requires execution
     */
    private tryLoadBundlerConfigStatic(configFile: string): void {
        const configPath = path.join(this.rootPath, configFile);
        try {
            const content = readFileSync(configPath, "utf-8");

            // Extract alias configurations using pattern matching
            const aliases = this.extractAliasesFromConfig(content);

            for (const [alias, target] of Object.entries(aliases)) {
                // Only add if not already defined (tsconfig takes priority)
                if (!this.pathAliases.has(alias)) {
                    const resolvedTarget = path.resolve(this.rootPath, target);

                    if (this.isPathSafe(resolvedTarget)) {
                        const relativePath = path.relative(this.rootPath, resolvedTarget);
                        this.pathAliases.set(alias, relativePath);
                    } else {
                        console.warn(
                            `[CodeGraph] Skipping unsafe bundler alias: ${alias} -> ${target}`,
                        );
                    }
                }
            }
        } catch {
            // Config file not found
        }
    }

    /**
     * Extract alias configurations from bundler config content.
     * Uses safe pattern matching - no execution.
     */
    private extractAliasesFromConfig(content: string): Record<string, string> {
        const aliases: Record<string, string> = {};

        // Remove comments and strings to avoid false matches
        const cleaned = this.removeCommentsAndStrings(content);

        // Pattern 1: Object literal aliases
        // alias: { '@': './src', '@components': './src/components' }
        const objectAliasRegex = /alias\s*:\s*\{([^}]+)\}/g;

        for (const match of cleaned.matchAll(objectAliasRegex)) {
            const aliasBlock = match[1];

            // Extract key-value pairs: '@': './src' or "@": "./src"
            const entryRegex = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;

            for (const entryMatch of aliasBlock.matchAll(entryRegex)) {
                const key = entryMatch[1];
                const value = entryMatch[2];

                // Only accept simple path strings (no functions, no variables)
                if (this.isSimplePath(value)) {
                    aliases[key] = value;
                }
            }
        }

        // Pattern 2: Array format (Vite)
        // alias: [{ find: '@', replacement: './src' }]
        const arrayAliasRegex = /alias\s*:\s*\[([^\]]+)\]/g;

        for (const match of cleaned.matchAll(arrayAliasRegex)) {
            const arrayBlock = match[1];

            // Extract find/replacement pairs
            const findRegex = /find\s*:\s*['"]([^'"]+)['"]/g;
            const replacementRegex = /replacement\s*:\s*['"]([^'"]+)['"]/g;

            const finds = [...arrayBlock.matchAll(findRegex)].map((m) => m[1]);
            const replacements = [...arrayBlock.matchAll(replacementRegex)].map((m) => m[1]);

            // Match finds with replacements
            for (let i = 0; i < Math.min(finds.length, replacements.length); i++) {
                if (this.isSimplePath(replacements[i])) {
                    aliases[finds[i]] = replacements[i];
                }
            }
        }

        return aliases;
    }

    /**
     * Remove comments and string literals to avoid false pattern matches.
     * Simple but effective for bundler configs.
     */
    private removeCommentsAndStrings(content: string): string {
        return (
            content
                // Remove single-line comments
                .replace(/\/\/.*$/gm, "")
                // Remove multi-line comments
                .replace(/\/\*[\s\S]*?\*\//g, "")
                // Remove template literals (keep structure)
                .replace(/`[^`]*`/g, '""')
                // Keep the structure but mark strings
                .replace(/'[^']*'/g, "''")
                .replace(/"[^"]*"/g, '""')
        );
    }

    /**
     * Check if a value looks like a simple path string.
     * Rejects function calls, variables, complex expressions.
     */
    private isSimplePath(value: string): boolean {
        // Must start with ./ or / or be a simple path like 'src'
        // Must not contain function calls or complex expressions
        const simplePathPattern = /^(\.{0,2}\/)?[\w\-/]+$/;
        return (
            simplePathPattern.test(value) &&
            !value.includes("(") &&
            !value.includes(")") &&
            !value.includes("$") &&
            !value.includes("{")
        );
    }

    /**
     * Load path aliases from tsconfig.json or jsconfig.json.
     * Uses JSON5-compatible parsing to handle comments.
     */
    private tryLoadCompilerConfig(configFile: string): boolean {
        const configPath = path.join(this.rootPath, configFile);
        try {
            const content = readFileSync(configPath, "utf-8");
            const config = this.parseJsonWithComments(content);

            if (!config || typeof config !== "object") {
                return false;
            }

            const compilerOptions = config["compilerOptions"];
            if (!compilerOptions || typeof compilerOptions !== "object") {
                return false;
            }

            const paths = (compilerOptions as Record<string, unknown>)["paths"];
            if (!paths || typeof paths !== "object") {
                return false;
            }

            const baseUrl = (compilerOptions as Record<string, unknown>)["baseUrl"];
            const baseUrlStr = typeof baseUrl === "string" ? baseUrl : ".";
            const baseUrlResolved = path.resolve(this.rootPath, baseUrlStr);

            for (const [alias, targets] of Object.entries(paths)) {
                if (!Array.isArray(targets) || targets.length === 0) continue;

                // Clean alias: '@/*' or '@*' → '@'
                const cleanAlias = alias.replace(/\/?\*$/, "");

                // Clean target: './src/*' or 'src/*' → 'src'
                const target = (targets[0] as string).replace(/\/?\*$/, "");

                // Resolve relative to baseUrl
                const resolvedTarget = path.resolve(baseUrlResolved, target);

                // Security: Validate path doesn't escape project root
                if (!this.isPathSafe(resolvedTarget)) {
                    console.warn(`[CodeGraph] Skipping unsafe alias: ${alias} -> ${target}`);
                    continue;
                }

                // Store as relative path from project root
                const relativePath = path.relative(this.rootPath, resolvedTarget);
                this.pathAliases.set(cleanAlias, relativePath);
            }

            return true;
        } catch (error) {
            // Log for debugging but don't crash
            if (process.env["DEBUG"]) {
                console.debug(
                    `[CodeGraph] Failed to load ${configFile}:`,
                    (error as Error).message,
                );
            }
            return false;
        }
    }

    /**
     * Parse JSON with comments using a simple but safe approach.
     * Only handles line comments that don't corrupt string values.
     */
    private parseJsonWithComments(content: string): Record<string, unknown> | null {
        try {
            // Try standard JSON first (fastest path)
            return JSON.parse(content);
        } catch {
            // Fallback: Remove comments carefully
            // This is limited but safe - only removes obvious comment lines
            const lines = content.split("\n");
            const cleaned: string[] = [];

            for (const line of lines) {
                const trimmed = line.trim();

                // Skip pure comment lines (safe)
                if (trimmed.startsWith("//") || trimmed.startsWith("/*")) {
                    continue;
                }

                // Keep lines that might have trailing comments
                // Don't try to remove them - too risky with URLs, etc.
                cleaned.push(line);
            }

            try {
                return JSON.parse(cleaned.join("\n"));
            } catch {
                // If still failing, the JSON is malformed or has inline comments
                // We can't safely parse it without a proper JSON5 parser
                return null;
            }
        }
    }

    /**
     * Validate that a path doesn't escape the project root.
     * Security measure to prevent path traversal.
     */
    private isPathSafe(targetPath: string): boolean {
        const normalized = path.normalize(targetPath);
        const relative = path.relative(this.rootPath, normalized);

        // Path is safe if it doesn't start with '..' (escape attempt)
        return !relative.startsWith("..") && !path.isAbsolute(relative);
    }

    /**
     * Add custom path aliases programmatically.
     * Recommended for complex projects instead of relying on auto-detection.
     *
     * @example
     * graph.addPathAlias('@components', 'src/components');
     * graph.addPathAlias('@utils', 'lib/utils');
     */
    addPathAlias(alias: string, target: string): void {
        const resolvedTarget = path.resolve(this.rootPath, target);

        if (!this.isPathSafe(resolvedTarget)) {
            throw new Error(`Invalid alias target (path traversal): ${alias} -> ${target}`);
        }

        const relativePath = path.relative(this.rootPath, resolvedTarget);
        this.pathAliases.set(alias, relativePath);
    }

    /**
     * Get all loaded path aliases.
     * Useful for debugging alias resolution issues.
     */
    getPathAliases(): Map<string, string> {
        return new Map(this.pathAliases);
    }

    // ============================================================================
    // Building the Tree
    // ============================================================================

    // Initialize from entry points (follow imports)
    async initialize(entryPoints: string[]): Promise<void> {
        const resolvedEntries = entryPoints.map((ep) => path.resolve(this.rootPath, ep));

        for (const entryPoint of resolvedEntries) {
            await this.addFile(entryPoint, 0);
        }

        // Compute tree hashes after building the tree
        this.computeTreeHashes();

        if (this.options.enableWatch) {
            this.startWatching();
        }
    }

    /**
     * Populate the in-memory graph from pre-loaded nodes (e.g. from database).
     * Skips file system scanning entirely.
     */
    loadFromNodes(nodes: Map<string, CodeNode>): void {
        this.nodes = new Map(nodes);
        this.computeTreeHashes();

        if (this.options.enableWatch) {
            this.startWatching();
        }
    }

    // Scan entire project (find all files)
    async scanProject(): Promise<void> {
        const ignoreMatcher = await this.getIgnoreMatcher();

        await this.traverseDirectory(this.rootPath, {
            extensions: this.options.extensions,
            ignoreMatcher,
            maxDepth: this.options.maxDepth,
            includeTests: this.options.includeTests,
            currentDepth: 0,
        });

        // Compute tree hashes after scanning
        this.computeTreeHashes();

        if (this.options.enableWatch) {
            this.startWatching();
        }
    }

    private async getIgnoreMatcher(): Promise<Ignore> {
        const matcher = ignore();
        // Test/report artifact dirs are never source code: their .gitignore
        // exceptions (e.g. `!.gitignore` inside test-results/) otherwise get
        // indexed as project files and show up as top-level "modules".
        const criticalExcludes = [
            ".git",
            "node_modules",
            ".raiken",
            "test-results",
            "test-reports",
            "playwright-report",
            "blob-report",
        ];
        matcher.add(criticalExcludes.map((name) => `${name}/`));
        matcher.add(criticalExcludes);

        if (this.options.excludeDirs && this.options.excludeDirs.length > 0) {
            matcher.add(this.options.excludeDirs.map((name) => `${name}/`));
        }

        if (!this.options.useGitignore) {
            return matcher;
        }

        const gitignorePath = path.join(this.rootPath, ".gitignore");
        try {
            const content = await fs.readFile(gitignorePath, "utf-8");
            matcher.add(content);
        } catch {
            // No .gitignore or unreadable file - ignore patterns only
        }

        return matcher;
    }

    /**
     * Traverse directory and process files.
     *
     * Directories are still processed depth-first to manage memory, but files
     * within a directory are processed in parallel batches of 10.
     */
    private async traverseDirectory(
        currentPath: string,
        options: {
            extensions: string[];
            ignoreMatcher: Ignore;
            maxDepth: number;
            includeTests: boolean;
            currentDepth: number;
        },
    ): Promise<void> {
        if (options.currentDepth >= options.maxDepth) return;

        try {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            const directories: string[] = [];
            const files: string[] = [];

            // Separate directories and files
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                const relativePath = path.relative(this.rootPath, fullPath);

                const ignorePath = this.toIgnorePath(relativePath, entry.isDirectory());
                if (ignorePath && options.ignoreMatcher.ignores(ignorePath)) continue;

                if (entry.isDirectory()) {
                    if (!options.includeTests && isTestDirectory(entry.name)) continue;
                    directories.push(fullPath);
                } else if (entry.isFile()) {
                    if (!options.includeTests && isTestFile(entry.name)) continue;
                    files.push(fullPath);
                }
            }

            // Process files in parallel batches
            const BATCH_SIZE = 10;
            for (let i = 0; i < files.length; i += BATCH_SIZE) {
                const batch = files.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map((file) => this.updateFile(file)));
            }

            // Process directories sequentially to control memory usage
            for (const dir of directories) {
                await this.traverseDirectory(dir, {
                    ...options,
                    currentDepth: options.currentDepth + 1,
                });
            }
        } catch (error) {
            const rel = path.relative(this.rootPath, currentPath);
            console.warn(`[CodeGraph] Failed to read directory ${rel}:`, (error as Error).message);
        }
    }

    // ============================================================================
    // Incremental Updates (React-like Diffing)
    // ============================================================================

    async updateFile(filePath: string): Promise<UpdateEvent> {
        const resolvedPath = path.resolve(filePath);
        const existingNode = this.nodes.get(resolvedPath);

        // Invalidate caches for this file
        this.invalidateCachesForFile(resolvedPath);

        if (!existingNode) {
            // New file - add it
            await this.addFile(resolvedPath, 0);
            const event: UpdateEvent = {
                type: "add",
                filePath: resolvedPath,
                affectedFiles: [resolvedPath],
                timestamp: new Date(),
            };
            this.notifyUpdate(event);
            return event;
        }

        // Re-parse the file
        const newNode = await this.parseFile(resolvedPath, existingNode.depth);

        if (!newNode) {
            return this.removeFile(resolvedPath);
        }

        // Diff imports (old vs new)
        const oldImports = new Set(existingNode.imports);
        const newImports = new Set(newNode.imports);

        const addedImports = Array.from(newImports).filter((imp) => !oldImports.has(imp));
        const removedImports = Array.from(oldImports).filter((imp) => !newImports.has(imp));

        const affectedFiles: string[] = [resolvedPath];

        // Handle removed imports
        for (const removedImport of removedImports) {
            const importedNode = this.nodes.get(removedImport);
            if (importedNode) {
                importedNode.importedBy = importedNode.importedBy.filter((p) => p !== resolvedPath);

                if (importedNode.importedBy.length === 0 && importedNode.depth > 0) {
                    await this.removeFile(removedImport);
                    affectedFiles.push(removedImport);
                }
            }
        }

        // Handle added imports
        for (const addedImport of addedImports) {
            if (!this.nodes.has(addedImport)) {
                await this.addFile(addedImport, existingNode.depth + 1);
                affectedFiles.push(addedImport);
            } else {
                const importedNode = this.nodes.get(addedImport);
                if (importedNode && !importedNode.importedBy.includes(resolvedPath)) {
                    importedNode.importedBy.push(resolvedPath);
                }
            }
        }

        // Update the node
        this.nodes.set(resolvedPath, newNode);

        // Recompute tree hashes for this node and all its dependents
        this.recomputeTreeHashesUpward(resolvedPath);

        const event: UpdateEvent = {
            type: "change",
            filePath: resolvedPath,
            affectedFiles,
            timestamp: new Date(),
        };

        this.notifyUpdate(event);
        return event;
    }

    async removeFile(filePath: string): Promise<UpdateEvent> {
        const resolvedPath = path.resolve(filePath);
        const node = this.nodes.get(resolvedPath);

        // Invalidate caches for this file
        this.invalidateCachesForFile(resolvedPath);

        if (!node) {
            // Not in the in-memory graph (e.g. never indexed, or already
            // removed) — still notify so callers whose source of truth is
            // the DB (ProjectContext.handleWatchEvent) get a chance to clean
            // up a stale row keyed by this path.
            const event: UpdateEvent = {
                type: "remove",
                filePath: resolvedPath,
                affectedFiles: [],
                timestamp: new Date(),
            };
            this.notifyUpdate(event);
            return event;
        }

        // Remove from all importedBy lists
        for (const imp of node.imports) {
            const importedNode = this.nodes.get(imp);
            if (importedNode) {
                importedNode.importedBy = importedNode.importedBy.filter((p) => p !== resolvedPath);
            }
        }

        // Remove from all imports lists
        for (const parent of node.importedBy) {
            const parentNode = this.nodes.get(parent);
            if (parentNode) {
                parentNode.imports = parentNode.imports.filter((p) => p !== resolvedPath);
            }
        }

        this.nodes.delete(resolvedPath);

        // Without this, chokidar's `unlink` handler in startWatching() deletes
        // the in-memory node but never reaches ProjectContext.handleWatchEvent
        // (the onUpdate callback) — the DB row, symbols, edges, and embeddings
        // for a deleted file used to live on forever.
        const event: UpdateEvent = {
            type: "remove",
            filePath: resolvedPath,
            affectedFiles: [resolvedPath],
            timestamp: new Date(),
        };
        this.notifyUpdate(event);
        return event;
    }

    private async addFile(
        filePath: string,
        depth: number,
        visited = new Set<string>(),
    ): Promise<void> {
        if (depth >= this.options.maxDepth) return;
        if (visited.has(filePath)) return;
        visited.add(filePath);
        if (this.nodes.has(filePath)) return;

        const node = await this.parseFile(filePath, depth);
        if (!node) return;

        this.nodes.set(filePath, node);

        // Update importedBy for dependencies
        for (const importPath of node.imports) {
            const importedNode = this.nodes.get(importPath);
            if (importedNode && !importedNode.importedBy.includes(filePath)) {
                importedNode.importedBy.push(filePath);
            }
        }

        // Recursively add imports
        for (const importPath of node.imports) {
            await this.addFile(importPath, depth + 1, visited);
        }
    }

    private async parseFile(filePath: string, depth: number): Promise<CodeNode | null> {
        try {
            const stats = await fs.stat(filePath);

            if (stats.size > this.options.maxFileSizeBytes) {
                const rel = path.relative(this.rootPath, filePath);
                console.warn(
                    `[CodeGraph] Skipping "${rel}" (${Math.round(stats.size / 1024)}KB) — exceeds the ${Math.round(
                        this.options.maxFileSizeBytes / 1024,
                    )}KB size limit for indexing. This avoids OOMs/hangs on huge generated files; it will not appear in search or impact analysis.`,
                );
                return null;
            }

            if (await isBinaryFile(filePath)) {
                return null;
            }

            const emptyParsed: ParsedFile = {
                functions: [],
                classes: [],
                imports: [],
                exports: [],
                types: [],
            };

            const extension = path.extname(filePath);
            const fileName = path.basename(filePath);
            const isCodeFile = this.isParseableFile(filePath);
            const code = await fs.readFile(filePath, "utf-8");
            const lineCount = code ? code.split("\n").length : 0;

            let parsed: ParsedFile = emptyParsed;
            let ast: unknown | undefined;
            let resolvedImports: string[] = [];
            let symbols: ParsedSymbol[] = [];
            let intraFileEdges: GraphEdge[] = [];

            // Markup files carry no code but do carry selectors, which is the
            // only source-side grounding a repo whose backend we cannot parse
            // will ever contribute.
            if (isCodeFile || isMarkupFile(filePath)) {
                try {
                    const result = analyzeSourceFile(code, filePath, {
                        unknownAsScript: isCodeFile,
                    });
                    parsed = result?.parsed ?? emptyParsed;
                    ast = result?.ast;

                    if (result?.parseError) {
                        const rel = path.relative(this.rootPath, filePath);
                        console.warn(
                            `[CodeGraph] Script block in ${rel} did not parse (${result.parseError}); indexed its template only.`,
                        );
                    }

                    resolvedImports = await this.resolveImports(
                        parsed.imports.map((imp) => imp.source),
                        filePath,
                    );

                    try {
                        if (ast) {
                            const extracted = extractSymbolsFromAst(ast, filePath);
                            symbols = extracted.symbols;
                            intraFileEdges = extracted.intraFileEdges;
                        }
                    } catch (symErr) {
                        // Always warn (not just under DEBUG) — a file silently
                        // ending up with zero symbols looks identical to a
                        // legitimately empty file otherwise, and the agent has
                        // no way to know its context for this file is missing.
                        const rel = path.relative(this.rootPath, filePath);
                        console.warn(
                            `[CodeGraph] Symbol extraction failed for ${rel}:`,
                            (symErr as Error).message,
                        );
                    }
                } catch (error) {
                    const rel = path.relative(this.rootPath, filePath);
                    console.warn(`[CodeGraph] Parse failed for ${rel}:`, (error as Error).message);
                    parsed = emptyParsed;
                    ast = undefined;
                    resolvedImports = [];
                }
            }

            const node: CodeNode = {
                filePath,
                relativePath: path.relative(this.rootPath, filePath),
                parsed,
                ast,
                symbols,
                intraFileEdges,
                imports: resolvedImports,
                importedBy: [],
                depth,
                lastModified: stats.mtimeMs,
                hash: this.hashContent(code),
                treeHash: "", // Will be computed after tree is built
                size: stats.size,
                lines: lineCount,
                meta: {
                    extension,
                    isTest: isTestFile(fileName),
                    isEntry: depth === 0,
                    hasExports: parsed.exports.length > 0,
                    hasDefaultExport: parsed.exports.includes("default"),
                    complexity: parsed.functions.length + parsed.classes.length,
                },
            };

            // Attach intra-file edges via a non-enumerable side channel so
            // serialization paths don't accidentally pick them up. They're consumed
            // by callers that persist the edge set (see CodeGraph.getIntraFileEdges).
            this.intraFileEdges.set(filePath, intraFileEdges);

            return node;
        } catch (error) {
            const rel = path.relative(this.rootPath, filePath);
            console.warn(`[CodeGraph] Could not process ${rel}:`, (error as Error).message);
            return null;
        }
    }

    /**
     * Resolve import paths to actual file paths.
     *
     * PERFORMANCE: Uses caching to avoid redundant file system checks.
     * Cache key format: "fromFile|source" ensures context-specific caching.
     */
    private async resolveImports(importSources: string[], fromFile: string): Promise<string[]> {
        const resolved: string[] = [];
        const fromDir = path.dirname(fromFile);

        // Batch all file existence checks for parallel execution
        const resolutionPromises = importSources.map(async (source) => {
            // Check cache first
            const cacheKey = `${fromFile}|${source}`;
            const cached = this.importCache.get(cacheKey);
            if (cached) {
                return cached;
            }

            // Skip node_modules
            if (!source.startsWith(".") && !source.startsWith("/") && !this.isAliasImport(source)) {
                return [];
            }

            let possiblePaths: string[] = [];

            if (source.startsWith(".") || source.startsWith("/")) {
                possiblePaths = this.generatePossiblePaths(source, fromDir);
            } else if (this.isAliasImport(source)) {
                const aliasResolved = this.resolveAlias(source);
                if (aliasResolved) {
                    possiblePaths = this.generatePossiblePaths(aliasResolved, this.rootPath);
                }
            }

            // Try each possible path
            for (const possiblePath of possiblePaths) {
                if (await this.fileExists(possiblePath)) {
                    const result = [possiblePath];
                    this.setCacheWithLimit(this.importCache, cacheKey, result);
                    return result;
                }
            }

            // Cache empty result
            this.setCacheWithLimit(this.importCache, cacheKey, []);
            return [];
        });

        // Wait for all resolutions in parallel
        const results = await Promise.all(resolutionPromises);

        // Flatten results
        for (const result of results) {
            resolved.push(...result);
        }

        return resolved;
    }

    /**
     * Check if file exists with caching to reduce fs operations.
     *
     * PERFORMANCE: File existence checks are expensive. This cache reduces
     * redundant fs.access() calls from O(n*m) to O(unique_paths).
     */
    private async fileExists(filePath: string): Promise<boolean> {
        const cached = this.fileExistsCache.get(filePath);
        if (cached !== undefined) {
            return cached;
        }

        try {
            await fs.access(filePath);
            this.setCacheWithLimit(this.fileExistsCache, filePath, true);
            return true;
        } catch {
            this.setCacheWithLimit(this.fileExistsCache, filePath, false);
            return false;
        }
    }

    private isAliasImport(source: string): boolean {
        for (const alias of this.pathAliases.keys()) {
            if (source === alias || source.startsWith(`${alias}/`)) {
                return true;
            }
        }
        return false;
    }

    private resolveAlias(source: string): string | null {
        for (const [alias, target] of this.pathAliases.entries()) {
            if (source === alias || source.startsWith(`${alias}/`)) {
                const remainder = source.slice(alias.length);
                return target + remainder;
            }
        }
        return null;
    }

    private generatePossiblePaths(importSource: string, fromDir: string): string[] {
        const baseResolve = path.resolve(fromDir, importSource);
        const possibilities: string[] = [];

        if (path.extname(importSource)) {
            possibilities.push(baseResolve);
            return possibilities;
        }

        for (const ext of this.options.extensions) {
            possibilities.push(baseResolve + ext);
        }

        for (const ext of this.options.extensions) {
            possibilities.push(path.join(baseResolve, `index${ext}`));
        }

        return possibilities;
    }

    private isParseableFile(filePath: string): boolean {
        const ext = path.extname(filePath);
        return this.options.extensions.includes(ext);
    }

    private toIgnorePath(relativePath: string, isDir: boolean): string {
        const normalized = relativePath.split(path.sep).join("/");
        if (!normalized) return normalized;
        return isDir ? `${normalized}/` : normalized;
    }

    /**
     * Fast non-cryptographic hash using FNV-1a algorithm.
     *
     * PERFORMANCE: FNV-1a is faster and has better distribution than the
     * previous simple hash. Uses bitwise operations for speed.
     *
     * Note: This is not cryptographically secure, but perfect for detecting
     * file changes where collision resistance is less critical.
     */
    private hashContent(content: string): string {
        let hash = 2166136261; // FNV offset basis

        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            // FNV prime: 16777619
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }

        return (hash >>> 0).toString(36);
    }

    /**
     * Invalidate caches for a specific file.
     * Called when a file is updated or removed.
     */
    private invalidateCachesForFile(filePath: string): void {
        // Invalidate import cache entries involving this file
        for (const key of this.importCache.keys()) {
            if (key.startsWith(`${filePath}|`) || key.includes(`|${filePath}`)) {
                this.importCache.delete(key);
            }
        }

        // Invalidate file exists cache for this file
        this.fileExistsCache.delete(filePath);

        // Keyword index must be rebuilt after file changes
        this.cachedKeywordIndex = null;
    }

    /**
     * Clear all caches. Useful for testing or when config changes.
     */
    clearCaches(): void {
        this.importCache.clear();
        this.fileExistsCache.clear();
        this.cachedKeywordIndex = null;
    }

    /**
     * Set cache value with size limit enforcement.
     * Evicts oldest entries when limit is reached.
     */
    private setCacheWithLimit<T>(cache: Map<string, T>, key: string, value: T): void {
        if (cache.size >= CodeGraph.CACHE_MAX_SIZE) {
            // Evict oldest 10% of entries (Map preserves insertion order)
            const evictCount = Math.floor(CodeGraph.CACHE_MAX_SIZE * 0.1);
            let count = 0;
            for (const k of cache.keys()) {
                if (count >= evictCount) break;
                cache.delete(k);
                count++;
            }
        }
        cache.set(key, value);
    }

    // ============================================================================
    // Watch Mode (Incremental Updates)
    // ============================================================================

    private startWatching(): void {
        if (this.watcher) return;

        void this.getIgnoreMatcher()
            .then((ignoreMatcher) => {
                if (this.watcher) return;

                const shouldIgnorePath = (filePath: string): boolean => {
                    const relativePath = path.relative(this.rootPath, filePath);
                    if (!relativePath || relativePath.startsWith("..")) return false;
                    const ignorePath = this.toIgnorePath(relativePath, false);
                    return ignorePath ? ignoreMatcher.ignores(ignorePath) : false;
                };

                const handleFile = async (
                    filePath: string,
                    eventType: "add" | "change" | "unlink",
                ) => {
                    if (shouldIgnorePath(filePath)) return;
                    await this.handleWatcherFileEvent(filePath, eventType);
                };

                this.watcher = chokidar.watch(this.rootPath, {
                    ignoreInitial: true,
                    persistent: true,
                    ignored: shouldIgnorePath,
                });

                this.watcher
                    .on("add", (filePath: string) => void handleFile(filePath, "add"))
                    .on("change", (filePath: string) => void handleFile(filePath, "change"))
                    .on("unlink", (filePath: string) => void handleFile(filePath, "unlink"));
            })
            .catch((error) => {
                console.warn("[CodeGraph] Watch mode disabled:", error);
            });
    }

    /**
     * Decide what an "add"/"change"/"unlink" filesystem event means for the
     * graph. Extracted from startWatching() so the ordering invariant below
     * is directly unit-testable rather than only reachable through a live
     * chokidar watcher.
     */
    private async handleWatcherFileEvent(
        filePath: string,
        eventType: "add" | "change" | "unlink",
    ): Promise<void> {
        // Deletions must be handled before any content check — the file is
        // already gone, so isBinaryFile() can only fail to open it. Checking
        // content here would (with a safe "treat I/O errors as skip" policy)
        // wrongly skip the removal entirely and leave a ghost DB row forever.
        if (eventType === "unlink") {
            await this.removeFile(filePath);
            return;
        }

        if (await isBinaryFile(filePath)) return;
        this.debounceUpdate(filePath);
    }

    private debounceUpdate(filePath: string): void {
        const existing = this.pendingUpdates.get(filePath);
        if (existing) clearTimeout(existing);

        const timeout = setTimeout(async () => {
            this.pendingUpdates.delete(filePath);
            await this.updateFile(filePath);
        }, 100);

        this.pendingUpdates.set(filePath, timeout);
    }

    stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = undefined;
        }

        for (const timeout of this.pendingUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingUpdates.clear();
    }

    private notifyUpdate(event: UpdateEvent): void {
        if (this.options.onUpdate) {
            this.options.onUpdate(event);
        }
    }

    // ============================================================================
    // Tree Hash Computation (Detect Changes in Subtrees)
    // ============================================================================

    /**
     * Compute tree hash for each node based on:
     * - Its own content hash
     * - Hashes of all its dependencies (imports)
     *
     * This allows detecting if ANY descendant changed, not just the file itself.
     */
    private computeTreeHashes(): void {
        const computed = new Set<string>();

        // Compute tree hash for each node (bottom-up)
        for (const node of this.nodes.values()) {
            this.computeNodeTreeHash(node.filePath, computed);
        }
    }

    private computeNodeTreeHash(
        filePath: string,
        computed: Set<string>,
        computing = new Set<string>(),
    ): string {
        // Already computed
        if (computed.has(filePath)) {
            const node = this.nodes.get(filePath);
            return node?.treeHash || "";
        }

        const node = this.nodes.get(filePath);
        if (!node) return "";

        // Circular dependency detection - use own hash if we're in a cycle
        if (computing.has(filePath)) {
            return node.hash;
        }

        // Mark as being computed
        computing.add(filePath);

        // Compute tree hashes for all dependencies first (bottom-up)
        const dependencyHashes: string[] = [];
        for (const importPath of node.imports) {
            const depHash = this.computeNodeTreeHash(importPath, computed, computing);
            if (depHash) {
                dependencyHashes.push(depHash);
            }
        }

        // Sort dependency hashes for consistent ordering
        dependencyHashes.sort();

        // Combine own hash + dependency hashes
        const combinedHash = `${node.hash}|${dependencyHashes.join("|")}`;
        node.treeHash = this.hashContent(combinedHash);

        computed.add(filePath);
        computing.delete(filePath);
        return node.treeHash;
    }

    /**
     * Check if a node's subtree has changed by comparing tree hashes
     */
    hasSubtreeChanged(filePath: string, oldTreeHash: string): boolean {
        const node = this.getNode(filePath);
        return node ? node.treeHash !== oldTreeHash : false;
    }

    /**
     * Recompute tree hashes upward (for a changed node and all its dependents)
     *
     * PERFORMANCE: This uses topological sorting to recompute hashes in dependency order,
     * avoiding redundant recomputation. Previous implementation cleared `computed` set
     * on each iteration, causing O(n²) behavior.
     */
    private recomputeTreeHashesUpward(filePath: string): void {
        const toRecompute: string[] = [filePath];
        const visited = new Set<string>();

        // Phase 1: Find all nodes that depend on this file (directly or indirectly)
        while (toRecompute.length > 0) {
            const current = toRecompute.pop();
            if (!current) {
                continue;
            }
            if (visited.has(current)) continue;
            visited.add(current);

            const node = this.nodes.get(current);
            if (node) {
                // Add all files that import this one
                for (const dependent of node.importedBy) {
                    if (!visited.has(dependent)) {
                        toRecompute.push(dependent);
                    }
                }
            }
        }

        // Phase 2: Topologically sort affected nodes (leaves first, roots last)
        const sorted = this.topologicalSort(Array.from(visited));

        // Phase 3: Recompute tree hashes in order (shared computed set for efficiency)
        const computed = new Set<string>();
        for (const affectedPath of sorted) {
            this.computeNodeTreeHash(affectedPath, computed);
        }
    }

    /**
     * Topologically sort nodes so dependencies are computed before dependents.
     * This ensures each node's tree hash is computed exactly once.
     *
     * PERFORMANCE OPTIMIZATIONS:
     * - O(1) queue operations using index pointer (vs O(n) shift)
     * - O(1) Set lookup for filePaths (vs O(n) includes)
     * - O(1) Set lookup for cycle detection (vs O(n) includes)
     *
     * Time Complexity: O(V + E) where V = files, E = imports
     * Space Complexity: O(V + E)
     */
    private topologicalSort(filePaths: string[]): string[] {
        // Convert to Set for O(1) lookup (critical optimization)
        const filePathsSet = new Set(filePaths);

        // Initialize data structures
        const inDegree = new Map<string, number>();
        const graph = new Map<string, string[]>();

        // Initialize all nodes with zero in-degree
        for (const filePath of filePaths) {
            inDegree.set(filePath, 0);
            graph.set(filePath, []);
        }

        // Build graph and compute in-degrees
        for (const filePath of filePaths) {
            const node = this.nodes.get(filePath);
            if (!node) continue;

            // For tree hash computation, we need dependencies computed first
            for (const dep of node.imports) {
                // O(1) Set lookup instead of O(n) array includes
                if (filePathsSet.has(dep)) {
                    const depNeighbors = graph.get(dep);
                    if (depNeighbors) {
                        depNeighbors.push(filePath);
                    }
                    const currentDegree = inDegree.get(filePath);
                    if (currentDegree !== undefined) {
                        inDegree.set(filePath, currentDegree + 1);
                    }
                }
            }
        }

        // Kahn's algorithm with optimized queue (index pointer instead of shift)
        const queue: string[] = [];
        let queueIndex = 0; // O(1) dequeue vs O(n) shift()

        // Start with nodes that have no dependencies
        for (const [node, degree] of inDegree) {
            if (degree === 0) {
                queue.push(node);
            }
        }

        const result: string[] = [];

        // Process queue with O(1) operations
        while (queueIndex < queue.length) {
            const current = queue[queueIndex++]; // O(1) vs shift() which is O(n)
            result.push(current);

            // Process all files that depend on current
            const neighbors = graph.get(current);
            if (!neighbors) continue;

            for (const neighbor of neighbors) {
                const currentDegree = inDegree.get(neighbor);
                if (currentDegree === undefined) continue;

                const newDegree = currentDegree - 1;
                inDegree.set(neighbor, newDegree);

                if (newDegree === 0) {
                    queue.push(neighbor);
                }
            }
        }

        // Handle cycles efficiently with Set lookup
        if (result.length < filePaths.length) {
            const resultSet = new Set(result); // O(1) lookup

            for (const filePath of filePaths) {
                if (!resultSet.has(filePath)) {
                    // O(1) vs includes() which is O(n)
                    result.push(filePath);
                }
            }
        }

        return result;
    }

    // ============================================================================
    // Query Methods (Access the Tree)
    // ============================================================================

    getNode(filePath: string): CodeNode | undefined {
        return this.nodes.get(path.resolve(filePath));
    }

    getDependencies(filePath: string): CodeNode[] {
        const node = this.getNode(filePath);
        if (!node) return [];

        return node.imports
            .map((imp) => this.nodes.get(imp))
            .filter((n): n is CodeNode => n !== undefined);
    }

    getDependents(filePath: string): CodeNode[] {
        const node = this.getNode(filePath);
        if (!node) return [];

        return node.importedBy
            .map((imp) => this.nodes.get(imp))
            .filter((n): n is CodeNode => n !== undefined);
    }

    getAllFiles(): CodeNode[] {
        return Array.from(this.nodes.values());
    }

    /**
     * Intra-file structural edges (extends/implements) collected during parse.
     * Used by persistence code to populate the unified graph_edges table.
     */
    getIntraFileEdges(filePath: string): GraphEdge[] {
        return this.intraFileEdges.get(filePath) ?? [];
    }

    getStats(): GraphStats {
        let totalFunctions = 0;
        let totalClasses = 0;

        for (const node of this.nodes.values()) {
            totalFunctions += node.parsed.functions.length;
            totalClasses += node.parsed.classes.length;
        }

        return {
            totalFiles: this.nodes.size,
            totalFunctions,
            totalClasses,
            lastUpdate: new Date(),
        };
    }

    // ============================================================================
    // Serialization (Export Tree as JSON)
    // ============================================================================

    toJSON(): object {
        return {
            rootPath: this.rootPath,
            stats: this.getStats(),
            files: Array.from(this.nodes.values()).map((node) => ({
                path: node.relativePath,
                depth: node.depth,
                size: node.size,
                lines: node.lines,
                hash: node.hash,
                treeHash: node.treeHash,
                functions: node.parsed.functions.length,
                classes: node.parsed.classes.length,
                imports: node.imports.map((imp) => path.relative(this.rootPath, imp)),
                importedBy: node.importedBy.map((imp) => path.relative(this.rootPath, imp)),
                lastModified: new Date(node.lastModified).toISOString(),
                meta: node.meta,
            })),
        };
    }

    destroy(): void {
        this.stopWatching();
        this.nodes.clear();
        this.clearCaches();
    }

    // ============================================================================
    // Project Understanding (Semantic Context)
    // ============================================================================

    /**
     * Build a keyword index for semantic search across the codebase.
     * Returns a map of keyword -> file paths for quick lookup.
     */
    buildKeywordIndex(): Map<string, string[]> {
        const index = new Map<string, string[]>();

        for (const node of this.nodes.values()) {
            const keywords = this.extractKeywordsFromPath(node.relativePath);

            // Add keywords from function/class names
            for (const fn of node.parsed.functions) {
                keywords.push(...this.splitIdentifier(fn.name));
            }
            for (const cls of node.parsed.classes) {
                keywords.push(...this.splitIdentifier(cls.name));
            }
            // Selector text is often the only searchable content a template has:
            // a Django page with no parseable code is reachable by "delete
            // workspace" only because its `data-testid` says so.
            for (const selector of node.parsed.templateSelectors ?? []) {
                keywords.push(...this.splitIdentifier(selector.value));
            }

            // Index each keyword
            for (const keyword of keywords) {
                const existing = index.get(keyword) || [];
                if (!existing.includes(node.relativePath)) {
                    existing.push(node.relativePath);
                }
                index.set(keyword, existing);
            }
        }

        return index;
    }

    /**
     * Find files relevant to a query using keyword matching.
     * Caches the keyword index to avoid rebuilding on every call.
     */
    findRelevantFiles(query: string, limit = 10): string[] {
        if (!this.cachedKeywordIndex) {
            this.cachedKeywordIndex = this.buildKeywordIndex();
        }

        const queryWords = this.extractKeywords(query);
        const scores = new Map<string, number>();

        for (const word of queryWords) {
            const matchingFiles = this.cachedKeywordIndex.get(word.toLowerCase());
            if (matchingFiles) {
                for (const file of matchingFiles) {
                    scores.set(file, (scores.get(file) || 0) + 1);
                }
            }
        }

        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([file]) => file);
    }

    /**
     * Get discovered modules (directories with meaningful groupings).
     */
    getModules(): Array<{ name: string; files: string[]; weight: number }> {
        const moduleMap = new Map<string, string[]>();

        for (const node of this.nodes.values()) {
            const moduleName = this.getModuleName(node.relativePath);
            if (!moduleMap.has(moduleName)) {
                moduleMap.set(moduleName, []);
            }
            moduleMap.get(moduleName)?.push(node.relativePath);
        }

        const totalFiles = this.nodes.size || 1;
        return Array.from(moduleMap.entries())
            .map(([name, files]) => ({
                name,
                files,
                weight: files.length / totalFiles,
            }))
            .sort((a, b) => b.weight - a.weight);
    }

    /**
     * Extract module name from file path.
     */
    private getModuleName(filePath: string): string {
        const parts = filePath.split("/").filter((p) => !p.includes("."));
        const skipDirs = new Set(["src", "app", "lib", "libs", "packages", "modules"]);

        for (const part of parts) {
            if (!skipDirs.has(part)) {
                return part;
            }
        }

        return parts[0] || "root";
    }

    /**
     * Extract keywords from a file path.
     */
    private extractKeywordsFromPath(filePath: string): string[] {
        const keywords: string[] = [];
        const basename = path.basename(filePath, path.extname(filePath));

        keywords.push(...this.splitIdentifier(basename));
        keywords.push(basename.toLowerCase());

        const dirs = filePath.split("/").slice(0, -1);
        for (const dir of dirs) {
            if (dir.length > 2 && !["src", "lib", "app"].includes(dir)) {
                keywords.push(dir.toLowerCase());
            }
        }

        return [...new Set(keywords)];
    }

    /**
     * Split an identifier into words (handles camelCase, PascalCase, etc.).
     */
    private splitIdentifier(identifier: string): string[] {
        return identifier
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }

    /**
     * Extract keywords from a query string.
     */
    private extractKeywords(query: string): string[] {
        return query
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }
}
