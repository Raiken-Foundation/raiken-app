import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { resolveAIConfig } from "../agent/ai-providers";
import { inspectAuthState, resolveAuthStorageStateDestination } from "../config/auth-state";
import { raikenConfigSchema } from "../config/schema";
import { readRawConfigSync } from "../config/store";
import type { HealthChecks, HealthStatus } from "./types";

export interface ComputeHealthOptions {
    version: string;
}

function probeConfig(projectPath: string): HealthChecks["config"] {
    try {
        const raw = readRawConfigSync(projectPath);
        if (!raw || Object.keys(raw).length === 0) return "missing";
        const parsed = raikenConfigSchema.safeParse(raw);
        return parsed.success ? "ok" : "invalid";
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return "missing";
        return "invalid";
    }
}

function probeDatabase(projectPath: string): HealthChecks["database"] {
    const dbPath = path.join(projectPath, ".raiken", "raiken.db");
    if (!fs.existsSync(dbPath)) return "missing";
    let db: Database.Database | undefined;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.prepare("SELECT 1").get();
        return "ok";
    } catch {
        return "unavailable";
    } finally {
        db?.close();
    }
}

function probeAi(projectPath: string): HealthChecks["ai"] {
    try {
        const resolved = resolveAIConfig(projectPath);
        if (resolved.apiKey) return "ok";
        return "degraded";
    } catch {
        return "unavailable";
    }
}

function isProcessAlive(pid: number | undefined): boolean {
    if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
    try {
        process.kill(pid as number, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but this user cannot signal it.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function probeOperation(projectPath: string): HealthChecks["operation"] {
    const manifestPath = path.join(projectPath, ".raiken", "operation.json");
    try {
        if (!fs.existsSync(manifestPath)) return "idle";
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as { kind?: string; pid?: number; startedAt?: number };
        if (!manifest.kind) return "idle";
        return isProcessAlive(manifest.pid) ? "busy" : "idle";
    } catch {
        return "idle";
    }
}

function probeAuth(projectPath: string): HealthChecks["auth"] {
    try {
        const statePath = resolveAuthStorageStateDestination(projectPath);
        const inspection = inspectAuthState(statePath);
        if (inspection.status === "missing") return "not_configured";
        if (inspection.status === "malformed") return "unavailable";
        if (inspection.status === "expired") return "degraded";
        if (inspection.status === "empty") return "degraded";
        return "ok";
    } catch {
        return "unavailable";
    }
}

/**
 * Lightweight readiness/degraded probes — no indexing, no side effects.
 * Safe to call from dashboard polling.
 */
export function computeHealthStatus(
    projectPath: string,
    options: ComputeHealthOptions,
): HealthStatus {
    const checks: HealthChecks = {
        config: probeConfig(projectPath),
        database: probeDatabase(projectPath),
        ai: probeAi(projectPath),
        operation: probeOperation(projectPath),
        auth: probeAuth(projectPath),
    };

    const notReady = checks.config === "invalid" || checks.database === "unavailable";

    const degraded =
        !notReady &&
        (checks.ai === "degraded" ||
            checks.ai === "unavailable" ||
            checks.auth === "degraded" ||
            checks.auth === "unavailable" ||
            checks.operation === "busy" ||
            checks.database === "missing" ||
            checks.config === "missing");

    const status: HealthStatus["status"] = notReady ? "not_ready" : degraded ? "degraded" : "ok";
    const readiness: HealthStatus["readiness"] = notReady ? "not_ready" : "ready";

    return {
        status,
        engine: "raiken",
        version: options.version,
        liveness: "alive",
        readiness,
        checks,
    };
}
