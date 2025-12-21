import * as fs from 'fs/promises';
import * as path from 'path';
import { watch, FSWatcher, readFileSync } from 'fs';
import { parseTypeScriptFile } from './ast-parser';
import { countLines } from '../utils';
import type { CodeGraphOptions, CodeNode, UpdateEvent, GraphStats } from '../types';
import { shouldIgnoreDirectory, shouldIgnoreFile, isTestDirectory, isTestFile } from '../utils';

// ============================================================================
// Code Graph - Tree Structure of Code Files
// ============================================================================

export class CodeGraph {
  private rootPath: string;
  private nodes = new Map<string, CodeNode>();
  private options: Required<Omit<CodeGraphOptions, 'onUpdate' | 'excludeDirs'>> & { 
    onUpdate?: (event: UpdateEvent) => void;
    excludeDirs?: string[];
  };
  private watcher?: FSWatcher;
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private pathAliases: Map<string, string> = new Map();
  // Performance optimization: Cache resolved import paths and existing file checks
  private importCache = new Map<string, string[]>();
  private fileExistsCache = new Map<string, boolean>();

  constructor(rootPath: string, options: CodeGraphOptions = {}) {
    this.rootPath = path.resolve(rootPath);
    this.options = {
      maxDepth: options.maxDepth ?? 10,
      extensions: options.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'],
      excludeDirs: options.excludeDirs,
      includeTests: options.includeTests ?? true,
      useGitignore: options.useGitignore ?? true,
      enableWatch: options.enableWatch ?? false,
      onUpdate: options.onUpdate
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
    for (const configFile of ['tsconfig.json', 'jsconfig.json']) {
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
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mts',
      'vite.config.mjs',
      'webpack.config.ts',
      'webpack.config.js',
      'webpack.config.mjs'
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
      const content = readFileSync(configPath, 'utf-8');
      
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
            console.warn(`[CodeGraph] Skipping unsafe bundler alias: ${alias} -> ${target}`);
          }
        }
      }
    } catch {
      // File doesn't exist or can't be read - silently skip
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
    let match;
    
    while ((match = objectAliasRegex.exec(cleaned)) !== null) {
      const aliasBlock = match[1];
      
      // Extract key-value pairs: '@': './src' or "@": "./src"
      const entryRegex = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
      let entryMatch;
      
      while ((entryMatch = entryRegex.exec(aliasBlock)) !== null) {
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
    
    while ((match = arrayAliasRegex.exec(cleaned)) !== null) {
      const arrayBlock = match[1];
      
      // Extract find/replacement pairs
      const findRegex = /find\s*:\s*['"]([^'"]+)['"]/g;
      const replacementRegex = /replacement\s*:\s*['"]([^'"]+)['"]/g;
      
      const finds: string[] = [];
      const replacements: string[] = [];
      
      let findMatch;
      while ((findMatch = findRegex.exec(arrayBlock)) !== null) {
        finds.push(findMatch[1]);
      }
      
      let replaceMatch;
      while ((replaceMatch = replacementRegex.exec(arrayBlock)) !== null) {
        replacements.push(replaceMatch[1]);
      }
      
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
    return content
      // Remove single-line comments
      .replace(/\/\/.*$/gm, '')
      // Remove multi-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Remove template literals (keep structure)
      .replace(/`[^`]*`/g, '""')
      // Keep the structure but mark strings
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""');
  }
  
  /**
   * Check if a value looks like a simple path string.
   * Rejects function calls, variables, complex expressions.
   */
  private isSimplePath(value: string): boolean {
    // Must start with ./ or / or be a simple path like 'src'
    // Must not contain function calls or complex expressions
    const simplePathPattern = /^(\.{0,2}\/)?[\w\-/]+$/;
    return simplePathPattern.test(value) && 
           !value.includes('(') && 
           !value.includes(')') &&
           !value.includes('$') &&
           !value.includes('{');
  }
  
  /**
   * Load path aliases from tsconfig.json or jsconfig.json.
   * Uses JSON5-compatible parsing to handle comments.
   */
  private tryLoadCompilerConfig(configFile: string): boolean {
      const configPath = path.join(this.rootPath, configFile);
      try {
        const content = readFileSync(configPath, 'utf-8');
      const config = this.parseJsonWithComments(content);
      
      if (!config || typeof config !== 'object') {
        return false;
      }
      
      const compilerOptions = config['compilerOptions'];
      if (!compilerOptions || typeof compilerOptions !== 'object') {
        return false;
      }
      
      const paths = (compilerOptions as Record<string, unknown>)['paths'];
      if (!paths || typeof paths !== 'object') {
        return false;
      }
      
      const baseUrl = (compilerOptions as Record<string, unknown>)['baseUrl'];
      const baseUrlStr = typeof baseUrl === 'string' ? baseUrl : '.';
      const baseUrlResolved = path.resolve(this.rootPath, baseUrlStr);
      
      for (const [alias, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        
        // Clean alias: '@/*' or '@*' → '@'
        const cleanAlias = alias.replace(/\/?\*$/, '');
        
        // Clean target: './src/*' or 'src/*' → 'src'
        const target = (targets[0] as string).replace(/\/?\*$/, '');
        
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
      if (process.env['DEBUG']) {
        console.debug(`[CodeGraph] Failed to load ${configFile}:`, (error as Error).message);
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
      const lines = content.split('\n');
      const cleaned: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Skip pure comment lines (safe)
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        
        // Keep lines that might have trailing comments
        // Don't try to remove them - too risky with URLs, etc.
        cleaned.push(line);
      }
      
      try {
        return JSON.parse(cleaned.join('\n'));
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
    return !relative.startsWith('..') && !path.isAbsolute(relative);
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
    const resolvedEntries = entryPoints.map(ep => path.resolve(this.rootPath, ep));
    
    for (const entryPoint of resolvedEntries) {
      await this.addFile(entryPoint, 0);
    }

    // Compute tree hashes after building the tree
    this.computeTreeHashes();

    if (this.options.enableWatch) {
      this.startWatching();
    }
  }

  // Scan entire project (find all files)
  async scanProject(): Promise<void> {
    const ignorePatterns = await this.getIgnorePatterns();
    
    await this.traverseDirectory(this.rootPath, {
      extensions: this.options.extensions,
      ignorePatterns,
      maxDepth: this.options.maxDepth,
      includeTests: this.options.includeTests,
      currentDepth: 0
    });

    // Compute tree hashes after scanning
    this.computeTreeHashes();

    if (this.options.enableWatch) {
      this.startWatching();
    }
  }

  private async getIgnorePatterns(): Promise<string[]> {
    if (!this.options.useGitignore) {
      return this.options.excludeDirs || ['node_modules', '.git'];
    }

    const patterns = await parseGitignore(this.rootPath);
    const criticalExcludes = ['.git', 'node_modules', '.raiken'];
    for (const dir of criticalExcludes) {
      if (!patterns.includes(dir)) {
        patterns.push(dir);
      }
    }
    return patterns;
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
      ignorePatterns: string[]; 
      maxDepth: number; 
      includeTests: boolean; 
      currentDepth: number 
    }
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

        if (entry.isDirectory()) {
          if (shouldIgnoreDirectory(entry.name, options.ignorePatterns)) continue;
          if (!options.includeTests && isTestDirectory(entry.name)) continue;
          
          directories.push(fullPath);
        } else if (entry.isFile()) {
           const ext = path.extname(entry.name);
           if (!options.extensions.includes(ext)) continue;
           if (shouldIgnoreFile(entry.name, relativePath, options.ignorePatterns)) continue;
           if (!options.includeTests && isTestFile(entry.name)) continue;

           files.push(fullPath);
        }
      }
      
      // Process files in parallel batches
      const BATCH_SIZE = 10;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(file => this.updateFile(file)));
      }
      
      // Process directories sequentially to control memory usage
      for (const dir of directories) {
        await this.traverseDirectory(dir, { ...options, currentDepth: options.currentDepth + 1 });
      }
    } catch {
      // Ignore errors
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
        type: 'add',
        filePath: resolvedPath,
        affectedFiles: [resolvedPath],
        timestamp: new Date()
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
    
    const addedImports = Array.from(newImports).filter(imp => !oldImports.has(imp));
    const removedImports = Array.from(oldImports).filter(imp => !newImports.has(imp));
    
    const affectedFiles: string[] = [resolvedPath];

    // Handle removed imports
    for (const removedImport of removedImports) {
      const importedNode = this.nodes.get(removedImport);
      if (importedNode) {
        importedNode.importedBy = importedNode.importedBy.filter(p => p !== resolvedPath);
        
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
        const importedNode = this.nodes.get(addedImport)!;
        if (!importedNode.importedBy.includes(resolvedPath)) {
          importedNode.importedBy.push(resolvedPath);
        }
      }
    }

    // Update the node
    this.nodes.set(resolvedPath, newNode);

    // Recompute tree hashes for this node and all its dependents
    this.recomputeTreeHashesUpward(resolvedPath);

    const event: UpdateEvent = {
      type: 'change',
      filePath: resolvedPath,
      affectedFiles,
      timestamp: new Date()
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
      return {
        type: 'remove',
        filePath: resolvedPath,
        affectedFiles: [],
        timestamp: new Date()
      };
    }

    // Remove from all importedBy lists
    for (const imp of node.imports) {
      const importedNode = this.nodes.get(imp);
      if (importedNode) {
        importedNode.importedBy = importedNode.importedBy.filter(p => p !== resolvedPath);
      }
    }

    // Remove from all imports lists
    for (const parent of node.importedBy) {
      const parentNode = this.nodes.get(parent);
      if (parentNode) {
        parentNode.imports = parentNode.imports.filter(p => p !== resolvedPath);
      }
    }

    this.nodes.delete(resolvedPath);

    return {
      type: 'remove',
      filePath: resolvedPath,
      affectedFiles: [resolvedPath],
      timestamp: new Date()
    };
  }

  private async addFile(filePath: string, depth: number, visited = new Set<string>()): Promise<void> {
    if (depth >= this.options.maxDepth) return;
    if (visited.has(filePath)) return;
    visited.add(filePath);
    if (this.nodes.has(filePath)) return;
    if (!this.isParseableFile(filePath)) return;

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
      const code = await fs.readFile(filePath, 'utf-8');
      const parsed = parseTypeScriptFile(code, filePath);
      const resolvedImports = await this.resolveImports(parsed.imports.map(imp => imp.source), filePath);
      const lineCount = await countLines(filePath);
      const extension = path.extname(filePath);
      const fileName = path.basename(filePath);

      const node: CodeNode = {
        filePath,
        relativePath: path.relative(this.rootPath, filePath),
        parsed,
        imports: resolvedImports,
        importedBy: [],
        depth,
        lastModified: stats.mtimeMs,
        hash: this.hashContent(code),
        treeHash: '', // Will be computed after tree is built
        size: stats.size,
        lines: lineCount,
        meta: {
          extension,
          isTest: isTestFile(fileName),
          isEntry: depth === 0,
          hasExports: parsed.exports.length > 0,
          hasDefaultExport: parsed.exports.includes('default'),
          complexity: parsed.functions.length + parsed.classes.length
        }
      };

      return node;
    } catch {
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
      if (!source.startsWith('.') && !source.startsWith('/') && !this.isAliasImport(source)) {
        return [];
      }

      let possiblePaths: string[] = [];

      if (source.startsWith('.') || source.startsWith('/')) {
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
          this.importCache.set(cacheKey, result);
          return result;
        }
      }
      
      // Cache empty result
      this.importCache.set(cacheKey, []);
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
      this.fileExistsCache.set(filePath, true);
      return true;
    } catch {
      this.fileExistsCache.set(filePath, false);
      return false;
    }
  }
  
  private isAliasImport(source: string): boolean {
    for (const alias of this.pathAliases.keys()) {
      if (source === alias || source.startsWith(alias + '/')) {
        return true;
      }
    }
    return false;
  }
  
  private resolveAlias(source: string): string | null {
    for (const [alias, target] of this.pathAliases.entries()) {
      if (source === alias || source.startsWith(alias + '/')) {
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
      if (key.startsWith(filePath + '|') || key.includes('|' + filePath)) {
        this.importCache.delete(key);
      }
    }
    
    // Invalidate file exists cache for this file
    this.fileExistsCache.delete(filePath);
  }
  
  /**
   * Clear all caches. Useful for testing or when config changes.
   */
  clearCaches(): void {
    this.importCache.clear();
    this.fileExistsCache.clear();
  }

  // ============================================================================
  // Watch Mode (Incremental Updates)
  // ============================================================================

  private startWatching(): void {
    if (this.watcher) return;

    this.watcher = watch(
      this.rootPath,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const fullPath = path.join(this.rootPath, filename);
        const ext = path.extname(filename);

        if (!this.options.extensions.includes(ext)) return;

        this.debounceUpdate(fullPath);
      }
    );
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

  private computeNodeTreeHash(filePath: string, computed: Set<string>, computing = new Set<string>()): string {
    // Already computed
    if (computed.has(filePath)) {
      const node = this.nodes.get(filePath);
      return node?.treeHash || '';
    }

    const node = this.nodes.get(filePath);
    if (!node) return '';

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
    const combinedHash = node.hash + '|' + dependencyHashes.join('|');
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
      const current = toRecompute.pop()!;
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
    let queueIndex = 0;  // O(1) dequeue vs O(n) shift()
    
    // Start with nodes that have no dependencies
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }
    
    const result: string[] = [];
    
    // Process queue with O(1) operations
    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];  // O(1) vs shift() which is O(n)
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
      const resultSet = new Set(result);  // O(1) lookup
      
      for (const filePath of filePaths) {
        if (!resultSet.has(filePath)) {  // O(1) vs includes() which is O(n)
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
      .map(imp => this.nodes.get(imp))
      .filter((n): n is CodeNode => n !== undefined);
  }

  getDependents(filePath: string): CodeNode[] {
    const node = this.getNode(filePath);
    if (!node) return [];

    return node.importedBy
      .map(imp => this.nodes.get(imp))
      .filter((n): n is CodeNode => n !== undefined);
  }

  getAllFiles(): CodeNode[] {
    return Array.from(this.nodes.values());
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
      files: Array.from(this.nodes.values()).map(node => ({
        path: node.relativePath,
        depth: node.depth,
        size: node.size,
        lines: node.lines,
        hash: node.hash,
        treeHash: node.treeHash,
        functions: node.parsed.functions.length,
        classes: node.parsed.classes.length,
        imports: node.imports.map(imp => path.relative(this.rootPath, imp)),
        importedBy: node.importedBy.map(imp => path.relative(this.rootPath, imp)),
        lastModified: new Date(node.lastModified).toISOString(),
        meta: node.meta
      }))
    };
  }

  destroy(): void {
    this.stopWatching();
    this.nodes.clear();
    this.clearCaches();
  }
}

async function parseGitignore(projectPath: string): Promise<string[]> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  const patterns: string[] = [];
  
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const pattern = trimmed.replace(/\/$/, '');
      if (pattern.startsWith('!')) continue;
      
      patterns.push(pattern);
    }
  } catch {
    return [];
  }
  
  return patterns;
}
