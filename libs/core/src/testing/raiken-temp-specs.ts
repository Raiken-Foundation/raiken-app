import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Scratch specs written by {@link TestExecutionService}. */
export const RAIKEN_RUN_SPEC_PATTERN = /\.raiken-run-(\d+)\.spec\.(ts|tsx|js|jsx)$/;

/** Ephemeral auth specs written by custom login. */
export const RAIKEN_AUTH_SPEC_PATTERN = /^raiken-auth-(\d+)-.+\.spec\.ts$/;

export interface SweepRaikenTempSpecsOptions {
    /** Directory that must live inside `containedRoot`. */
    directory: string;
    /** Project or test root that `directory` must stay within. */
    containedRoot: string;
    /** Filename pattern with a capture group for the embedded timestamp (ms). */
    pattern: RegExp;
    /** Delete matches older than this many milliseconds. */
    maxAgeMs: number;
}

function assertContainedPath(directory: string, containedRoot: string): string {
    const resolvedDir = path.resolve(directory);
    const resolvedRoot = path.resolve(containedRoot);
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Refusing to sweep specs outside contained root: ${directory}`);
    }
    return resolvedDir;
}

/**
 * Remove stale Raiken-generated temp specs matching `pattern` when their
 * embedded timestamp is older than `maxAgeMs`. Only operates inside
 * `containedRoot`.
 */
export async function sweepStaleRaikenTempSpecs(
    options: SweepRaikenTempSpecsOptions,
): Promise<void> {
    const directory = assertContainedPath(options.directory, options.containedRoot);
    try {
        const now = Date.now();
        for (const name of await fs.readdir(directory)) {
            const timestamp = Number(options.pattern.exec(name)?.[1]);
            if (!Number.isFinite(timestamp) || now - timestamp <= options.maxAgeMs) continue;
            const target = path.join(directory, name);
            const resolvedTarget = path.resolve(target);
            if (resolvedTarget !== directory && !resolvedTarget.startsWith(directory + path.sep)) {
                continue;
            }
            await fs.rm(resolvedTarget, { force: true });
        }
    } catch {
        // Directory may not exist yet.
    }
}

export const DEFAULT_RAIKEN_TEMP_SPEC_MAX_AGE_MS = 10 * 60 * 1000;

export async function sweepStaleRunSpecs(
    projectPath: string,
    directory: string,
    maxAgeMs = DEFAULT_RAIKEN_TEMP_SPEC_MAX_AGE_MS,
): Promise<void> {
    await sweepStaleRaikenTempSpecs({
        directory,
        containedRoot: projectPath,
        pattern: RAIKEN_RUN_SPEC_PATTERN,
        maxAgeMs,
    });
}

export async function sweepStaleAuthSpecs(
    projectPath: string,
    testDir: string,
    maxAgeMs = DEFAULT_RAIKEN_TEMP_SPEC_MAX_AGE_MS,
): Promise<void> {
    await sweepStaleRaikenTempSpecs({
        directory: testDir,
        containedRoot: projectPath,
        pattern: RAIKEN_AUTH_SPEC_PATTERN,
        maxAgeMs,
    });
}
