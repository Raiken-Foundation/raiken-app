import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AutonomySettings } from "../agent/tools";
import { conflictError } from "../errors";
import type { TestRunResult } from "../testing/runner";
import { lock } from "proper-lockfile";

export type HitlWorkflowStatus =
    | "await_save_approval"
    | "await_run_approval"
    | "repairing"
    | "await_repair_review"
    | "completed"
    | "failed"
    | "cancelled";

export interface HitlWorkflowRecord {
    id: string;
    version: 1;
    kind: "test_generate_repair";
    status: HitlWorkflowStatus;
    createdAt: number;
    updatedAt: number;
    origin: "agent" | "dashboard" | "repl";
    savedTestPath?: string;
    testDraft?: string;
    testName?: string;
    shouldRunTests: boolean;
    repairAttempts: number;
    autonomy?: Pick<AutonomySettings, "autoCorrect" | "maxRetries" | "autoLearn">;
    lastRunResults?: TestRunResult[];
    lastRepairedCode?: string;
    statusMessage?: string;
    /** Deliberately excludes prompts, chat history, and credentials. */
    pendingAction?: "save" | "run";
    runSummary?: { passed: boolean; failureCount: number };
}

const TERMINAL_STATUSES = new Set<HitlWorkflowStatus>(["completed", "failed", "cancelled"]);

export class WorkflowStore {
    private readonly directory: string;

    constructor(projectPath: string) {
        this.directory = path.join(projectPath, ".raiken", "workflows");
    }

    async create(
        record: Omit<HitlWorkflowRecord, "id" | "version" | "createdAt" | "updatedAt">,
    ): Promise<HitlWorkflowRecord> {
        const now = Date.now();
        const created: HitlWorkflowRecord = {
            ...record,
            id: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
        await this.write(created);
        return created;
    }

    async load(id: string): Promise<HitlWorkflowRecord | null> {
        try {
            const raw = await fs.readFile(this.filePath(id), "utf-8");
            const parsed = JSON.parse(raw) as HitlWorkflowRecord;
            return parsed?.version === 1 && parsed.id === id ? parsed : null;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Missing files and unparsable records read as "no record".
            // Permission/transient errors must NOT masquerade as "missing" —
            // that silently hides every pending approval (review finding).
            if (code === "ENOENT" || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async listActive(): Promise<HitlWorkflowRecord[]> {
        try {
            const entries = await fs.readdir(this.directory, { withFileTypes: true });
            const records = await Promise.all(
                entries
                    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
                    .map((entry) => this.load(entry.name.slice(0, -".json".length))),
            );
            return records.filter(
                (record): record is HitlWorkflowRecord =>
                    record !== null && !TERMINAL_STATUSES.has(record.status),
            );
        } catch {
            return [];
        }
    }

    async update(
        id: string,
        patch: Partial<Omit<HitlWorkflowRecord, "id" | "version" | "createdAt">>,
        options: { expectedUpdatedAt?: number } = {},
    ): Promise<HitlWorkflowRecord | null> {
        const target = this.filePath(id);
        await fs.mkdir(this.directory, { recursive: true });
        // The load→merge→write cycle is a read-modify-write on a file the
        // dashboard (tRPC) and CLI drive cross-process; ChatHistoryStore
        // takes proper-lockfile for exactly this reason (review finding).
        const release = await lock(target, {
            realpath: false,
            stale: 10_000,
            update: 3_000,
            retries: 3,
        });
        try {
            const existing = await this.load(id);
            if (!existing) return null;
            if (
                options.expectedUpdatedAt !== undefined &&
                existing.updatedAt !== options.expectedUpdatedAt
            ) {
                // Compare-and-swap: a decision computed against a stale
                // snapshot must never be applied over a newer decision.
                throw conflictError(
                    "The workflow changed while the decision was in flight — re-check its current state and try again.",
                    { code: "RESOURCE_CONFLICT" },
                );
            }
            const updated = this.finalizeTerminal({
                ...existing,
                ...patch,
                updatedAt: Date.now(),
            });
            await this.write(updated);
            return updated;
        } finally {
            await release().catch(() => undefined);
        }
    }

    private finalizeTerminal(record: HitlWorkflowRecord): HitlWorkflowRecord {
        if (!TERMINAL_STATUSES.has(record.status)) return record;
        return {
            ...record,
            testDraft: undefined,
            pendingAction: undefined,
            lastRunResults: undefined,
            lastRepairedCode: undefined,
        };
    }

    private filePath(id: string): string {
        return path.join(this.directory, `${id}.json`);
    }

    private async write(record: HitlWorkflowRecord): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
        const target = this.filePath(record.id);
        const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
            await fs.rename(temporary, target);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}

export function formatActiveWorkflowAttention(workflow: HitlWorkflowRecord): string {
    const target = workflow.savedTestPath ? ` for \`${workflow.savedTestPath}\`` : "";
    if (workflow.status === "await_save_approval") {
        return `A generated test is awaiting save approval${target} — approve or reject it in chat or the dashboard.`;
    }
    if (workflow.status === "await_run_approval") {
        return `A saved test is awaiting run approval${target} — approve or skip it in chat or the dashboard.`;
    }
    if (workflow.status === "repairing") {
        return `A test repair was interrupted${target} — resume it from the dashboard or run the test again.`;
    }
    return `Automatic repair needs manual review${target} — open the test and review the latest failure.`;
}
