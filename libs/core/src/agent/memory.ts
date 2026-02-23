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
        const existing = this.instances.get(projectPath);
        if (existing) {
            return existing;
        }

        const instance = new AgentMemory(projectPath);
        this.instances.set(projectPath, instance);
        return instance;
    }

    /**
     * Clear all instances (for testing)
     */
    static clearInstances(): void {
        for (const instance of this.instances.values()) {
            instance.close();
        }
        this.instances.clear();
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize the memory system.
     * Loads preferences into cache.
     */
    initialize(): void {
        if (this.initialized) return;

        // Load all preferences into cache
        const allPrefs = this.db.getAllPreferences();
        for (const [key, value] of Object.entries(allPrefs)) {
            this.preferencesCache.set(key, value);
        }

        this.initialized = true;
        console.log(`🧠 AgentMemory initialized: ${this.preferencesCache.size} preferences loaded`);
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
        if (Object.prototype.hasOwnProperty.call(state, "activeGoal")) {
            this.setPreference("active_goal", state.activeGoal ?? "");
        }
        if (Object.prototype.hasOwnProperty.call(state, "targetFeature")) {
            this.setPreference("target_feature", state.targetFeature ?? "");
        }
        if (Object.prototype.hasOwnProperty.call(state, "targetUrl")) {
            this.setPreference("target_url", state.targetUrl ?? "");
        }
        if (Object.prototype.hasOwnProperty.call(state, "nextTool")) {
            this.setPreference("next_tool", state.nextTool ?? "");
        }
        if (Object.prototype.hasOwnProperty.call(state, "missingContext")) {
            const value = JSON.stringify(state.missingContext || []);
            this.setPreference("missing_context", value);
        }
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
        selectorType: "data-testid" | "role" | "text" | "css" | "xpath" | "other"
    ): void {
        this.db.recordSelectorSuccess(elementDescription, selector, selectorType);
    }

    /**
     * Record a failed selector usage.
     */
    recordSelectorFailure(elementDescription: string, selector: string): void {
        this.db.recordSelectorFailure(elementDescription, selector);
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
        generatedCode: string
    ): number {
        return this.db.recordTestGenerated(testFile, testName, sourcePrompt, generatedCode);
    }

    /**
     * Record the result of running a test.
     */
    recordTestResult(
        testId: number,
        status: "passed" | "failed" | "error" | "timeout",
        executionTimeMs?: number,
        errorMessage?: string,
        failingSelector?: string
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
