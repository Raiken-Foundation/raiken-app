/**
 * Eval harness types.
 *
 * A *scenario* bundles a target app (optional), a task to run against it,
 * and scorers that judge the output. The harness stays target-agnostic:
 * playground fixtures give ground-truth scoring, arbitrary projects get
 * outcome-based scoring (did the suite stay green across reruns), and
 * LLM-dependent scenarios declare their requirements so they skip cleanly
 * instead of failing when no API key is configured.
 */

export interface EvalScore {
    name: string;
    passed: boolean;
    /** Optional numeric measurement backing the pass/fail (count, ms, rate). */
    value?: number;
    detail?: string;
}

export interface EvalAttemptContext {
    /**
     * Fresh temp directory for this attempt, used as the `projectPath` for
     * anything that persists state (SQLite DBs, traces) so attempts never
     * contaminate each other or a real project.
     */
    workDir: string;
    /** Base URL of the started target, or null for target-less scenarios. */
    baseUrl: string | null;
    log: (message: string) => void;
}

export interface EvalScorer<T> {
    name: string;
    score: (output: T, ctx: EvalAttemptContext) => Promise<EvalScore> | EvalScore;
}

/** A running app under test with a lifecycle the runner controls. */
export interface EvalTarget {
    name: string;
    start(): Promise<{ baseUrl: string }>;
    stop(): Promise<void>;
}

export interface EvalScenario<T = unknown> {
    id: string;
    description: string;
    /**
     * Environment variables that must be set for this scenario to run
     * (e.g. an LLM API key). Missing requirements skip the scenario with a
     * reason instead of failing the suite.
     */
    requiresEnv?: string[];
    /** Created per attempt; the runner guarantees `stop()` runs. */
    createTarget?: () => EvalTarget;
    run: (ctx: EvalAttemptContext) => Promise<T>;
    scorers: Array<EvalScorer<T>>;
}

export interface EvalAttemptResult {
    attempt: number;
    passed: boolean;
    scores: EvalScore[];
    /** Set when the attempt threw before scoring completed. */
    error?: string;
    durationMs: number;
}

export interface ScenarioReport {
    id: string;
    description: string;
    /** Reason the scenario was skipped (unmet requirements); no attempts ran. */
    skipped?: string;
    attempts: EvalAttemptResult[];
    /** Fraction of attempts in which every scorer passed. 0 for skipped. */
    passRate: number;
}

export interface EvalReport {
    startedAt: number;
    durationMs: number;
    repeat: number;
    scenarios: ScenarioReport[];
    /** True only when at least one scenario ran and every selected scenario passed all attempts. */
    passed: boolean;
}

export interface RunEvalOptions {
    /** Attempts per scenario. Defaults to 1. */
    repeat?: number;
    /** Only run scenarios whose id includes this substring. */
    filter?: string;
    log?: (message: string) => void;
    /** Keep per-attempt work directories on disk (default: deleted). */
    keepWorkDirs?: boolean;
}
