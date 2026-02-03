import { CodeGraph } from "./code-graph";
import { CodeGraphDB } from "../database/db";
import type { CodeNode } from "../types";

/**
 * File change information from the orchestrator
 */
export interface FileChange {
    path: string;
    type: "added" | "modified" | "deleted";
    contentChanged: boolean;
}

/**
 * Context validation result
 */
export interface ContextValidation {
    isValid: boolean;
    reason?: string;
    changedFiles: string[];
    needsReparse: boolean;
}

/**
 * ProjectContext - Singleton for cached project understanding
 *
 * Responsibilities:
 * - Holds cached CodeGraph and keyword index
 * - Provides fast file lookups without rescanning
 * - Validates cache freshness
 * - Handles incremental refresh
 *
 * Lifecycle:
 * 1. Initialized once at server startup
 * 2. Agent calls shouldUseCache() before using cached data
 * 3. Orchestrator signals changes via notifyChanges()
 * 4. Agent refreshes via refresh() when needed
 */
export class ProjectContext {
    private static instances = new Map<string, ProjectContext>();

    private projectPath: string;
    private graph: CodeGraph | null = null;
    private keywordIndex: Map<string, string[]> = new Map();
    private modules: Array<{ name: string; files: string[]; weight: number }> = [];
    private lastScanTime = 0;
    private initialized = false;

    // Track files that have changed since last scan
    private pendingChanges: FileChange[] = [];

    // Staleness threshold (5 minutes)
    private static readonly STALE_THRESHOLD_MS = 5 * 60 * 1000;

    private constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    /**
     * Get or create a ProjectContext instance for a project path.
     * Singleton pattern ensures one instance per project.
     */
    static getInstance(projectPath: string): ProjectContext {
        const existing = this.instances.get(projectPath);
        if (existing) {
            return existing;
        }

        const instance = new ProjectContext(projectPath);
        this.instances.set(projectPath, instance);
        return instance;
    }

    /**
     * Clear all instances (for testing)
     */
    static clearInstances(): void {
        for (const instance of this.instances.values()) {
            instance.destroy();
        }
        this.instances.clear();
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize the context by scanning the project.
     * Should be called once at server startup.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            console.log("ProjectContext already initialized");
            return;
        }

        console.log("Initializing ProjectContext...");

        // Create CodeGraph
        this.graph = new CodeGraph(this.projectPath, {
            includeTests: false,
            useGitignore: true,
            maxDepth: 15,
        });

        // Check if DB already has files
        const db = new CodeGraphDB(this.projectPath);
        const existingFiles = db.getFiles();

        if (existingFiles.length > 0) {
            // Load from DB instead of rescanning
            console.log(`Loading ${existingFiles.length} files from database...`);
            await this.graph.scanProject(); // Still need to populate graph
        } else {
            // Full scan
            console.log("Scanning project...");
            await this.graph.scanProject();
        }

        // Build keyword index
        this.keywordIndex = this.graph.buildKeywordIndex();
        this.modules = this.graph.getModules();
        this.lastScanTime = Date.now();
        this.initialized = true;

        // Try to load keyword index from DB (for faster cold starts)
        const savedIndex = this.loadKeywordIndexFromDB(db);
        if (savedIndex && savedIndex.size > 0) {
            console.log(`Loaded ${savedIndex.size} keywords from database`);
            // Merge with freshly built index (fresh takes priority)
            for (const [keyword, files] of savedIndex) {
                if (!this.keywordIndex.has(keyword)) {
                    this.keywordIndex.set(keyword, files);
                }
            }
        }

        // Save keyword index to DB for next cold start
        this.saveKeywordIndexToDB(db);

        db.close();

        console.log(
            `ProjectContext initialized: ${this.keywordIndex.size} keywords, ${this.modules.length} modules`
        );
    }

    /**
     * Check if context is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    // =========================================================================
    // Cache Validation (Agent uses these)
    // =========================================================================

    /**
     * Check if context is stale (time-based)
     */
    isStale(): boolean {
        return Date.now() - this.lastScanTime > ProjectContext.STALE_THRESHOLD_MS;
    }

    /**
     * Determine if cached context should be used for a query.
     * Called by Agent before using cached data.
     *
     * @param query - The user's query
     * @param changedFiles - Files that orchestrator detected as changed
     * @returns true if cache is valid for this query
     */
    shouldUseCache(query: string, changedFiles?: string[]): boolean {
        // Not initialized? Can't use cache
        if (!this.initialized) {
            return false;
        }

        // Stale? Don't use cache
        if (this.isStale()) {
            return false;
        }

        // No changes reported? Use cache
        if (!changedFiles || changedFiles.length === 0) {
            return true;
        }

        // Check if any changed files are relevant to this query
        const relevantFiles = this.findRelevantFilesInternal(query, 20);
        const hasOverlap = relevantFiles.some((f) => changedFiles.includes(f));

        // If changed files don't overlap with query-relevant files, cache is still valid
        return !hasOverlap;
    }

    /**
     * Validate context for a query and return detailed result.
     * Called by Agent to understand cache state.
     */
    validateContext(query: string, changedFiles?: string[]): ContextValidation {
        if (!this.initialized) {
            return {
                isValid: false,
                reason: "Context not initialized",
                changedFiles: changedFiles || [],
                needsReparse: true,
            };
        }

        if (this.isStale()) {
            return {
                isValid: false,
                reason: `Context stale (last scan: ${new Date(this.lastScanTime).toISOString()})`,
                changedFiles: changedFiles || [],
                needsReparse: false, // Stale but no specific files need reparse
            };
        }

        if (changedFiles && changedFiles.length > 0) {
            const relevantFiles = this.findRelevantFilesInternal(query, 20);
            const overlapping = relevantFiles.filter((f) => changedFiles.includes(f));

            if (overlapping.length > 0) {
                return {
                    isValid: false,
                    reason: `Changed files overlap with query: ${overlapping.slice(0, 3).join(", ")}`,
                    changedFiles: overlapping,
                    needsReparse: true,
                };
            }
        }

        return {
            isValid: true,
            changedFiles: [],
            needsReparse: false,
        };
    }

    /**
     * Ensure the context is initialized and fresh for a query.
     */
    async ensureFreshContext(query: string, changedFiles?: string[]): Promise<ContextValidation> {
        if (!this.initialized) {
            await this.initialize();
        }

        const validation = this.validateContext(query, changedFiles);
        if (!validation.isValid) {
            await this.refresh(validation.changedFiles);
        }
        return validation;
    }

    // =========================================================================
    // File Lookup (Fast, uses cached index)
    // =========================================================================

    /**
     * Find files relevant to a query using cached keyword index.
     * This is the main method Agent should use.
     */
    findRelevantFiles(query: string, limit = 10): string[] {
        if (!this.initialized) {
            console.warn("ProjectContext not initialized, returning empty");
            return [];
        }

        return this.findRelevantFilesInternal(query, limit);
    }

    /**
     * Internal implementation using cached index
     */
    private findRelevantFilesInternal(query: string, limit: number): string[] {
        const queryWords = this.extractKeywords(query);
        const scores = new Map<string, number>();

        for (const word of queryWords) {
            const matchingFiles = this.keywordIndex.get(word.toLowerCase());
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
     * Get cached modules
     */
    getModules(): Array<{ name: string; files: string[]; weight: number }> {
        return this.modules;
    }

    /**
     * Get keyword count (for logging)
     */
    getKeywordCount(): number {
        return this.keywordIndex.size;
    }

    /**
     * Get file count
     */
    getFileCount(): number {
        return this.graph?.getAllFiles().length || 0;
    }

    /**
     * Get all file paths (relative to project root).
     */
    getAllFilePaths(): string[] {
        if (!this.graph) {
            return [];
        }
        return this.graph.getAllFiles().map((node) => node.relativePath);
    }

    // =========================================================================
    // Change Notification (Orchestrator uses these)
    // =========================================================================

    /**
     * Notify context of file changes.
     * Called by Orchestrator when it detects changes.
     */
    notifyChanges(changes: FileChange[]): void {
        this.pendingChanges.push(...changes);
    }

    /**
     * Get pending changes
     */
    getPendingChanges(): FileChange[] {
        return [...this.pendingChanges];
    }

    /**
     * Clear pending changes (after they've been processed)
     */
    clearPendingChanges(): void {
        this.pendingChanges = [];
    }

    // =========================================================================
    // Refresh (Agent calls when cache is invalid)
    // =========================================================================

    /**
     * Refresh context for specific files.
     * Called by Agent when cache validation fails.
     */
    async refresh(changedFiles?: string[]): Promise<void> {
        if (!this.initialized || !this.graph) {
            await this.initialize();
            return;
        }

        if (!changedFiles || changedFiles.length === 0) {
            // Full refresh
            console.log("Full context refresh...");
            await this.graph.scanProject();
            this.keywordIndex = this.graph.buildKeywordIndex();
            this.modules = this.graph.getModules();
        } else {
            // Incremental refresh - update only changed files
            console.log(`Incremental refresh: ${changedFiles.length} files`);

            // Update keyword index for changed files only
            for (const filePath of changedFiles) {
                this.updateKeywordsForFile(filePath);
            }

            // Rebuild modules (relatively cheap)
            this.modules = this.graph.getModules();
        }

        this.lastScanTime = Date.now();
        this.clearPendingChanges();

        // Persist updated index
        const db = new CodeGraphDB(this.projectPath);
        this.saveKeywordIndexToDB(db);
        db.close();
    }

    /**
     * Update keywords for a single file
     */
    private updateKeywordsForFile(filePath: string): void {
        // Remove old keywords for this file
        for (const [keyword, files] of this.keywordIndex) {
            const filtered = files.filter((f) => f !== filePath);
            if (filtered.length === 0) {
                this.keywordIndex.delete(keyword);
            } else if (filtered.length !== files.length) {
                this.keywordIndex.set(keyword, filtered);
            }
        }

        // Add new keywords from updated file
        if (this.graph) {
            const node = this.graph.getNode(filePath);
            if (node) {
                const keywords = this.extractKeywordsFromNode(node);
                for (const keyword of keywords) {
                    const existing = this.keywordIndex.get(keyword) || [];
                    if (!existing.includes(filePath)) {
                        existing.push(filePath);
                    }
                    this.keywordIndex.set(keyword, existing);
                }
            }
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Extract keywords from a CodeNode
     */
    private extractKeywordsFromNode(node: CodeNode): string[] {
        const keywords: string[] = [];

        // From path
        const basename = node.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
        keywords.push(...this.splitIdentifier(basename));
        keywords.push(basename.toLowerCase());

        // From functions
        for (const fn of node.parsed.functions) {
            keywords.push(...this.splitIdentifier(fn.name));
        }

        // From classes
        for (const cls of node.parsed.classes) {
            keywords.push(...this.splitIdentifier(cls.name));
        }

        return [...new Set(keywords)];
    }

    /**
     * Extract keywords from a query string
     */
    private extractKeywords(query: string): string[] {
        return query
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }

    /**
     * Split identifier into words
     */
    private splitIdentifier(identifier: string): string[] {
        return identifier
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }

    // =========================================================================
    // DB Persistence for Keyword Index
    // =========================================================================

    /**
     * Save keyword index to database
     */
    private saveKeywordIndexToDB(db: CodeGraphDB): void {
        try {
            // Use the new method we'll add to CodeGraphDB
            db.saveKeywordIndex(this.keywordIndex);
        } catch (error) {
            console.warn("Failed to save keyword index:", error);
        }
    }

    /**
     * Load keyword index from database
     */
    private loadKeywordIndexFromDB(db: CodeGraphDB): Map<string, string[]> | null {
        try {
            return db.loadKeywordIndex();
        } catch (error) {
            console.warn("Failed to load keyword index:", error);
            return null;
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Destroy the context and release resources
     */
    destroy(): void {
        if (this.graph) {
            this.graph.destroy();
            this.graph = null;
        }
        this.keywordIndex.clear();
        this.modules = [];
        this.pendingChanges = [];
        this.initialized = false;
        this.lastScanTime = 0;
    }
}
