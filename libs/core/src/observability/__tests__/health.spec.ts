import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeHealthStatus } from "../health";

describe("computeHealthStatus", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-health-"));
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it("reports ok/readiness for a fresh project with missing config/db", () => {
        const health = computeHealthStatus(projectPath, { version: "test" });
        expect(health.engine).toBe("raiken");
        expect(health.liveness).toBe("alive");
        expect(health.readiness).toBe("ready");
        expect(health.status).toBe("degraded");
        expect(health.checks.config).toBe("missing");
        expect(health.checks.database).toBe("missing");
    });

    it("reports not_ready when config is invalid", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ discovery: { maxPages: "not-a-number" } }),
        );
        const health = computeHealthStatus(projectPath, { version: "test" });
        expect(health.status).toBe("not_ready");
        expect(health.readiness).toBe("not_ready");
        expect(health.checks.config).toBe("invalid");
    });

    it("reports not_ready when database is unavailable", () => {
        fs.writeFileSync(path.join(projectPath, "raiken.config.json"), JSON.stringify({}));
        const dbPath = path.join(projectPath, ".raiken", "raiken.db");
        fs.writeFileSync(dbPath, "not-a-database");
        const health = computeHealthStatus(projectPath, { version: "test" });
        expect(health.status).toBe("not_ready");
        expect(health.readiness).toBe("not_ready");
        expect(health.checks.database).toBe("unavailable");
    });

    it("reports degraded (not not_ready) when optional AI/auth are missing", () => {
        const health = computeHealthStatus(projectPath, { version: "test" });
        expect(health.status).toBe("degraded");
        expect(health.readiness).toBe("ready");
    });

    it("preserves legacy top-level fields", () => {
        const health = computeHealthStatus(projectPath, { version: "1.2.3" });
        expect(health).toMatchObject({
            engine: "raiken",
            version: "1.2.3",
        });
    });

    it("reports a live operation as busy", () => {
        fs.writeFileSync(
            path.join(projectPath, ".raiken", "operation.json"),
            JSON.stringify({ kind: "test", pid: process.pid, startedAt: Date.now() }),
        );
        expect(computeHealthStatus(projectPath, { version: "test" }).checks.operation).toBe("busy");
    });

    it("ignores an operation manifest left by a dead process", () => {
        fs.writeFileSync(
            path.join(projectPath, ".raiken", "operation.json"),
            JSON.stringify({ kind: "test", pid: 2_147_483_647, startedAt: 1 }),
        );
        expect(computeHealthStatus(projectPath, { version: "test" }).checks.operation).toBe("idle");
    });
});
