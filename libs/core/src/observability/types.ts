/** Structured log levels for observability events. */
export type ObservabilityLevel = "debug" | "info" | "warn" | "error";

/**
 * Cross-cutting identifiers propagated through requests, runs, and errors.
 * Reuses existing domain IDs rather than inventing parallel ones.
 */
export interface CorrelationContext {
    correlationId?: string;
    operationId?: string;
    workflowId?: string;
    discoverySessionId?: string;
    runId?: string;
    /** Privacy-safe project reference (hash + basename), never absolute paths. */
    projectRef?: string;
    requestId?: string;
}

/** Structured observability event — safe for JSON logging after redaction. */
export interface ObservabilityEvent extends CorrelationContext {
    level: ObservabilityLevel;
    /** Stable machine-readable event name, e.g. `agent.run.completed`. */
    event: string;
    at: number;
    message?: string;
    durationMs?: number;
    status?: string | number;
    meta?: Record<string, unknown>;
}

/** Injectable sink for tests and alternate transports. */
export type ObservabilitySink = (event: ObservabilityEvent) => void;

export interface ObservabilityConfig {
    /** Emit JSON lines to stderr when true. */
    jsonLogging: boolean;
    /** Minimum level to emit. */
    minLevel: ObservabilityLevel;
}

export type HealthCheckStatus =
    | "ok"
    | "degraded"
    | "unavailable"
    | "invalid"
    | "missing"
    | "idle"
    | "busy"
    | "not_configured"
    | "expired"
    | "malformed";

export interface HealthChecks {
    config: Extract<HealthCheckStatus, "ok" | "invalid" | "missing">;
    database: Extract<HealthCheckStatus, "ok" | "unavailable" | "missing">;
    ai: Extract<HealthCheckStatus, "ok" | "degraded" | "unavailable">;
    operation: Extract<HealthCheckStatus, "idle" | "busy">;
    auth: Extract<HealthCheckStatus, "ok" | "degraded" | "unavailable" | "not_configured">;
}

/** Health contract — preserves legacy fields and adds readiness probes. */
export interface HealthStatus {
    /** Legacy top-level status; extended with degraded/not_ready. */
    status: "ok" | "degraded" | "not_ready";
    engine: "raiken";
    version: string;
    liveness: "alive";
    readiness: "ready" | "not_ready";
    checks: HealthChecks;
}
