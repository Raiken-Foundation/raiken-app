import path from "node:path";
import { CodeGraphDB } from "../database/db";
import type { AgentIntent } from "./graph/utils";

/**
 * Selector information with confidence score
 */
export interface SelectorInfo {
    selector: string;
    selectorType: string;
    confidence: number;
}

/**
 * Test outcome information
 */
export interface TestOutcome {
    id: number;
    testFile: string;
    testName: string;
    sourcePrompt: string;
    generatedCode: string;
    status: string;
    errorMessage: string | null;
}

/**
 * Recent failure information
 */
export interface RecentFailure {
    id: number;
    testFile: string;
    testName: string;
    errorMessage: string | null;
    failingSelector: string | null;
    lastRun: number;
}

/**
 * AgentMemory - Singleton for persistent agent memory
 *
 * Provides a high-level interface for:
 * - User preferences (persisted across sessions)
 * - Selector history (what worked/failed)
 * - Test outcomes (track generated tests)
 *
 * Uses CodeGraphDB for persistence.
 */
export class AgentMemory {
    private static instances = new Map<string, AgentMemory>();

    private projectPath: string;
    private db: CodeGraphDB;
    private initialized = false;

    // In-memory cache for frequently accessed preferences
    private preferencesCache: Map<string, string> = new Map();

    private constructor(projectPath: string) {
        this.projectPath = projectPath;
        this.db = new CodeGraphDB(projectPath);
    }

    /**
     * Get or create an AgentMemory instance for a project path.
     * Singleton pattern ensures one instance per project.
     */
    static getInstance(projectPath: string): AgentMemory {
        // Key on the resolved absolute path so callers passing "." vs an
        // absolute path (or a trailing slash) share one instance + DB handle
        // instead of opening duplicate connections to the same project.
        const key = path.resolve(projectPath);
        const existing = AgentMemory.instances.get(key);
        if (existing) {
            return existing;
        }

        const instance = new AgentMemory(key);
        AgentMemory.instances.set(key, instance);
        return instance;
    }

    /**
     * Clear all instances (for testing)
     */
    static clearInstances(): void {
        for (const instance of AgentMemory.instances.values()) {
            instance.close();
        }
        AgentMemory.instances.clear();
    }

    /**
     * Expose a SelectorMemory-compatible sink backed by this AgentMemory.
     * Use this to bind the BrowserSession's selector tracking to persistent
     * storage without forcing the browser layer to depend on AgentMemory.
     */
    asSelectorMemory(): {
        recordSuccess: (
            element: string,
            selector: string,
            kind: "data-testid" | "role" | "text" | "css" | "xpath" | "other",
        ) => void;
        recordFailure: (
            element: string,
            selector: string,
            kind: "data-testid" | "role" | "text" | "css" | "xpath" | "other",
        ) => void;
    } {
        return {
            recordSuccess: (element, selector, kind) => {
                this.recordSelectorSuccess(element, selector, kind);
            },
            recordFailure: (element, selector, kind) => {
                this.recordSelectorFailure(element, selector, kind);
            },
        };
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize the memory system.
     * Loads preferences into cache.
     */
    private static readonly MAX_SELECTOR_ROWS = 500;
    private static readonly MAX_TEST_OUTCOME_ROWS = 200;

    /** @param verbose Log the loaded-preferences summary (default `true`; the CLI REPL passes `false` and shows its own status UI instead). */
    initialize(verbose = true): void {
        if (this.initialized) return;

        const allPrefs = this.db.getAllPreferences();
        for (const [key, value] of Object.entries(allPrefs)) {
            this.preferencesCache.set(key, value);
        }

        this.prune();

        this.initialized = true;
        if (verbose) {
            console.log(
                `AgentMemory initialized: ${this.preferencesCache.size} preferences loaded`,
            );
        }
    }

    /**
     * Prune old selector history and test outcome rows to prevent unbounded growth.
     */
    private prune(): void {
        try {
            this.db.pruneHistory(AgentMemory.MAX_SELECTOR_ROWS, AgentMemory.MAX_TEST_OUTCOME_ROWS);
        } catch (error) {
            console.warn("Memory pruning failed:", error instanceof Error ? error.message : error);
        }
    }

    /**
     * Check if memory is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    // =========================================================================
    // Preferences
    // =========================================================================

    /**
     * Set a preference value.
     * Persisted to database and cached in memory.
     */
    setPreference(key: string, value: string): void {
        this.db.setPreference(key, value);
        this.preferencesCache.set(key, value);
    }

    /**
     * Get a preference value.
     * Returns from cache if available, falls back to database.
     */
    getPreference(key: string, defaultValue?: string): string | null {
        if (this.preferencesCache.has(key)) {
            return this.preferencesCache.get(key)!;
        }

        const value = this.db.getPreference(key);
        if (value !== null) {
            this.preferencesCache.set(key, value);
        }
        return value ?? defaultValue ?? null;
    }

    /**
     * Get all preferences as an object.
     */
    getAllPreferences(): Record<string, string> {
        return this.db.getAllPreferences();
    }

    // =========================================================================
    // Common Preference Helpers
    // =========================================================================

    /**
     * Get preferred selector strategy.
     */
    getSelectorStrategy(): string | null {
        return this.getPreference("selector_strategy");
    }

    /**
     * Set preferred selector strategy.
     */
    setSelectorStrategy(strategy: "data-testid" | "role" | "text" | "css"): void {
        this.setPreference("selector_strategy", strategy);
    }

    /**
     * Get last known active intent.
     */
    getActiveIntent(): AgentIntent | null {
        const value = this.getPreference("active_intent");
        if (value === "explore" || value === "generateTests" || value === "explain") {
            return value;
        }
        return null;
    }

    /**
     * Persist active intent for continuity across turns.
     */
    setActiveIntent(intent: AgentIntent): void {
        this.setPreference("active_intent", intent);
    }

    /**
     * Get persisted goal state for continuity.
     */
    getGoalState(): {
        activeGoal: string | null;
        targetFeature: string | null;
        targetUrl: string | null;
        missingContext: string[];
        nextTool: string | null;
    } {
        const activeGoal = this.getPreference("active_goal");
        const targetFeature = this.getPreference("target_feature");
        const targetUrl = this.getPreference("target_url");
        const nextTool = this.getPreference("next_tool");
        const missingRaw = this.getPreference("missing_context");
        let missingContext: string[] = [];
        if (missingRaw) {
            try {
                const parsed = JSON.parse(missingRaw);
                if (Array.isArray(parsed)) {
                    missingContext = parsed.filter((item) => typeof item === "string");
                }
            } catch {
                missingContext = [];
            }
        }
        return {
            activeGoal: activeGoal || null,
            targetFeature: targetFeature || null,
            targetUrl: targetUrl || null,
            missingContext,
            nextTool: nextTool || null,
        };
    }

    /**
     * Persist goal state for continuity across sessions.
     */
    setGoalState(state: {
        activeGoal?: string | null;
        targetFeature?: string | null;
        targetUrl?: string | null;
        missingContext?: string[];
        nextTool?: string | null;
    }): void {
        if (Object.hasOwn(state, "activeGoal")) {
            this.setPreference("active_goal", state.activeGoal ?? "");
        }
        if (Object.hasOwn(state, "targetFeature")) {
            this.setPreference("target_feature", state.targetFeature ?? "");
        }
        if (Object.hasOwn(state, "targetUrl")) {
            this.setPreference("target_url", state.targetUrl ?? "");
        }
        if (Object.hasOwn(state, "nextTool")) {
            this.setPreference("next_tool", state.nextTool ?? "");
        }
        if (Object.hasOwn(state, "missingContext")) {
            const value = JSON.stringify(state.missingContext || []);
            this.setPreference("missing_context", value);
        }
    }

    /**
     * Persist the latest exploration snapshot (URLs, current URL, and per-page
     * summaries) so the agent remembers where it has been and what it saw
     * across *every* turn — not just when it pauses. This is read without
     * clearing so context survives normal completions too.
     */
    private static readonly MAX_REMEMBERED_PAGES = 50;
    private static readonly MAX_REMEMBERED_SUMMARIES = 20;

    setLastExploration(state: {
        pagesVisited?: string[];
        currentUrl?: string | null;
        pageSummaries?: string[];
    }): void {
        if (state.pagesVisited !== undefined) {
            const pages = state.pagesVisited.slice(-AgentMemory.MAX_REMEMBERED_PAGES);
            this.setPreference("last_explore_pages", JSON.stringify(pages));
        }
        if (state.currentUrl !== undefined) {
            this.setPreference("last_explore_url", state.currentUrl ?? "");
        }
        if (state.pageSummaries !== undefined) {
            const summaries = state.pageSummaries.slice(-AgentMemory.MAX_REMEMBERED_SUMMARIES);
            this.setPreference("last_explore_summaries", JSON.stringify(summaries));
        }
        // Stamp the write so stale crawls (from an old, unrelated task) aren't
        // silently dragged into a new session — callers check the age.
        this.setPreference("last_explore_at", String(Date.now()));
    }

    /** Age (ms) of the last remembered exploration, or Infinity if none. */
    getLastExplorationAgeMs(): number {
        const raw = this.getPreference("last_explore_at");
        const ts = raw ? Number(raw) : NaN;
        return Number.isFinite(ts) ? Date.now() - ts : Number.POSITIVE_INFINITY;
    }

    /** Clear the remembered exploration snapshot (used on new/unrelated tasks). */
    clearLastExploration(): void {
        this.setPreference("last_explore_pages", "");
        this.setPreference("last_explore_url", "");
        this.setPreference("last_explore_summaries", "");
        this.setPreference("last_explore_at", "");
    }

    /** Clear persisted goal state (used after a task completes). */
    clearGoalState(): void {
        this.setGoalState({
            activeGoal: null,
            targetFeature: null,
            targetUrl: null,
            missingContext: [],
            nextTool: null,
        });
    }

    /**
     * Return every persisted action path (e.g. "sign out", "add to cart") the
     * agent has previously located, keyed by action name. Lets test generation
     * reuse known routes/selectors for ALL actions, not just logout.
     */
    getActionPaths(): Array<{ action: string; page: string | null; selector: string | null }> {
        const out: Array<{ action: string; page: string | null; selector: string | null }> = [];
        for (const [key, value] of Object.entries(this.getAllPreferences())) {
            if (!key.startsWith("action_path:") || !value) continue;
            try {
                const parsed = JSON.parse(value) as {
                    page?: string | null;
                    selector?: string | null;
                };
                out.push({
                    action: key.slice("action_path:".length),
                    page: parsed.page ?? null,
                    selector: parsed.selector ?? null,
                });
            } catch {
                /* skip malformed entry */
            }
        }
        return out;
    }

    /**
     * Retrieve the latest exploration snapshot without clearing it.
     * Returns null when nothing has been remembered yet.
     */
    getLastExploration(): {
        pagesVisited: string[];
        currentUrl: string | null;
        pageSummaries: string[];
    } | null {
        const pagesRaw = this.getPreference("last_explore_pages");
        const summariesRaw = this.getPreference("last_explore_summaries");
        const currentUrl = this.getPreference("last_explore_url");

        if (!pagesRaw && !summariesRaw && !currentUrl) return null;

        const parseStringArray = (raw: string | null): string[] => {
            if (!raw) return [];
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
            } catch {
                return [];
            }
        };

        const pagesVisited = parseStringArray(pagesRaw);
        const pageSummaries = parseStringArray(summariesRaw);

        if (pagesVisited.length === 0 && pageSummaries.length === 0 && !currentUrl) {
            return null;
        }

        return {
            pagesVisited,
            currentUrl: currentUrl || null,
            pageSummaries,
        };
    }

    /**
     * Get default test directory.
     */
    getTestDirectory(): string {
        return this.getPreference("test_directory", "e2e") ?? "e2e";
    }

    /**
     * Set default test directory.
     */
    setTestDirectory(directory: string): void {
        this.setPreference("test_directory", directory);
    }

    // =========================================================================
    // Selector History
    // =========================================================================

    /**
     * Record a successful selector usage.
     */
    recordSelectorSuccess(
        elementDescription: string,
        selector: string,
        selectorType: "data-testid" | "role" | "text" | "css" | "xpath" | "other",
    ): void {
        this.db.recordSelectorSuccess(elementDescription, selector, selectorType);
    }

    /**
     * Record a failed selector usage.
     */
    recordSelectorFailure(
        elementDescription: string,
        selector: string,
        selectorType: "data-testid" | "role" | "text" | "css" | "xpath" | "other" = "other",
    ): void {
        this.db.recordSelectorFailure(elementDescription, selector, selectorType);
    }

    /**
     * Get the best known selector for an element.
     * Returns null if no selector history exists.
     */
    getBestSelector(elementDescription: string): SelectorInfo | null {
        return this.db.getBestSelector(elementDescription);
    }

    /**
     * Get all successful selectors for prompt context.
     */
    getSuccessfulSelectors(limit = 20): Array<{
        element: string;
        selector: string;
        type: string;
        confidence: number;
    }> {
        return this.db.getSuccessfulSelectors(limit);
    }

    // =========================================================================
    // Test Outcomes
    // =========================================================================

    /**
     * Record a newly generated test.
     * Returns the test ID for future updates.
     */
    recordTestGenerated(
        testFile: string,
        testName: string,
        sourcePrompt: string,
        generatedCode: string,
        sourceFiles?: string[],
    ): number {
        const id = this.db.recordTestGenerated(testFile, testName, sourcePrompt, generatedCode);
        if (sourceFiles && sourceFiles.length > 0) {
            this.db.recordTestSourceFiles(testFile, sourceFiles);
        }
        return id;
    }

    /**
     * Record the result of running a test.
     */
    recordTestResult(
        testId: number,
        status: "passed" | "failed" | "error" | "timeout",
        executionTimeMs?: number,
        errorMessage?: string,
        failingSelector?: string,
    ): void {
        this.db.recordTestResult(testId, status, executionTimeMs, errorMessage, failingSelector);
    }

    /**
     * Get recent test failures for prompt context.
     */
    getRecentFailures(limit = 10): RecentFailure[] {
        return this.db.getRecentFailures(limit);
    }

    /**
     * Get a specific test outcome.
     */
    getTestOutcome(testId: number): TestOutcome | null {
        return this.db.getTestOutcome(testId);
    }

    // =========================================================================
    // Context Building (for prompts)
    // =========================================================================

    /**
     * Build memory context for inclusion in prompts.
     * Returns a structured object with relevant memory data.
     */
    buildPromptContext(): {
        selectorStrategy: string | null;
        successfulSelectors: Array<{ element: string; selector: string; type: string }>;
        recentFailures: Array<{ testName: string; error: string }>;
    } {
        // Lazily initialize so learned selectors/failures reach prompts even
        // when the caller (tests, direct library use, non-server entry points)
        // never called `initialize()`. `initialize()` is idempotent.
        if (!this.initialized) this.initialize();
        const selectorStrategy = this.getSelectorStrategy();
        const successfulSelectors = this.getSuccessfulSelectors(10).map((s) => ({
            element: s.element,
            selector: s.selector,
            type: s.type,
        }));
        const recentFailures = this.getRecentFailures(3).map((f) => ({
            testName: f.testName,
            error: f.errorMessage ?? "Unknown error",
        }));

        return {
            selectorStrategy,
            successfulSelectors,
            recentFailures,
        };
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Close the database connection.
     */
    close(): void {
        this.db.close();
        this.preferencesCache.clear();
        this.initialized = false;
        // Drop ourselves from the singleton map so a later getInstance() builds
        // a fresh, usable instance instead of handing back this closed one.
        if (AgentMemory.instances.get(this.projectPath) === this) {
            AgentMemory.instances.delete(this.projectPath);
        }
    }

    /**
     * Register process cleanup handlers.
     * Call this once during application startup to ensure proper cleanup.
     */
    static registerProcessCleanup(): void {
        const cleanup = () => {
            AgentMemory.clearInstances();
        };

        // Handle graceful shutdown signals
        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
        process.once("beforeExit", cleanup);
    }
}

// Auto-register cleanup handlers when module is loaded
AgentMemory.registerProcessCleanup();
