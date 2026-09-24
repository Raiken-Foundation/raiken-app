import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { lock as lockfileLock } from "proper-lockfile";
import { cancelledError, conflictError } from "../errors";

export type ProjectOperationKind = "agent" | "test" | "discovery" | "browser";

export interface ProjectOperationManifest {
    kind: ProjectOperationKind;
    pid: number;
    startedAt: number;
}

export interface ProjectOperationLease {
    manifest: ProjectOperationManifest;
    release(): Promise<void>;
}

const STALE_MS = 45_000;
const UPDATE_MS = 15_000;

export async function acquireProjectOperation(
    projectPath: string,
    kind: ProjectOperationKind,
    signal?: AbortSignal,
): Promise<ProjectOperationLease> {
    if (signal?.aborted) {
        throw cancelledError("Operation cancelled.");
    }
    const dir = path.join(projectPath, ".raiken");
    fs.mkdirSync(dir, { recursive: true });
    const lockTarget = path.join(dir, "operation.lock");
    const manifestPath = path.join(dir, "operation.json");

    try {
        const releaseLock = await lockfileLock(lockTarget, {
            realpath: false,
            stale: STALE_MS,
            update: UPDATE_MS,
            retries: 0,
        });
        const manifest = { kind, pid: process.pid, startedAt: Date.now() };
        await fsPromises.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf-8");
        return {
            manifest,
            async release() {
                await fsPromises.rm(manifestPath, { force: true }).catch(() => undefined);
                await releaseLock();
            },
        };
    } catch (error) {
        if ((error as { code?: string })?.code === "ELOCKED") {
            let holder = "another Raiken operation";
            try {
                const raw = await fsPromises.readFile(manifestPath, "utf-8");
                const manifest = JSON.parse(raw) as Partial<ProjectOperationManifest>;
                if (manifest.kind)
                    holder = `${manifest.kind} operation (PID ${manifest.pid ?? "unknown"})`;
            } catch {
                // A stale or pre-manifest lock still gets a useful generic error.
            }
            throw conflictError(
                `${holder} is already active for this project. Please wait or cancel it.`,
                { code: "OPERATION_BUSY", details: { holder } },
            );
        }
        throw error;
    }
}
