/**
 * Browser-safe health contract types for dashboard polling.
 * Values are produced server-side by `@raiken/core` `computeHealthStatus`.
 */

export interface HealthChecks {
    config: "ok" | "invalid" | "missing";
    database: "ok" | "unavailable" | "missing";
    ai: "ok" | "degraded" | "unavailable";
    operation: "idle" | "busy";
    auth: "ok" | "degraded" | "unavailable" | "not_configured";
}

export interface HealthStatus {
    status: "ok" | "degraded" | "not_ready";
    engine: "raiken";
    version: string;
    liveness: "alive";
    readiness: "ready" | "not_ready";
    checks: HealthChecks;
}
