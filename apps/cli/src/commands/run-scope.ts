/**
 * Shared quarantine scoping for full-suite runs. `raiken test` and
 * `raiken report` must agree on which specs run: quarantined specs
 * (`quarantine.testFiles` in raiken.config.json) are excluded by default so a
 * known-flaky spec can't poison every suite-wide invocation.
 */

import {
    createProjectApplication,
    loadQuarantineConfig,
    partitionQuarantinedSpecs,
} from "@raiken/core";

export interface QuarantinePartition {
    quarantine: string[];
    included: string[];
    excluded: string[];
}

/**
 * Partition the on-disk suite by the quarantine list. Returns null when no
 * quarantine is configured — callers then run the suite unfiltered.
 */
export async function partitionSuiteSpecs(
    projectPath: string,
): Promise<QuarantinePartition | null> {
    const quarantine = loadQuarantineConfig(projectPath).testFiles;
    if (quarantine.length === 0) return null;
    const app = createProjectApplication(projectPath);
    const { files } = await app.testing.listTestFiles();
    const { included, excluded } = partitionQuarantinedSpecs(
        files.map((f) => f.path),
        quarantine,
    );
    return { quarantine, included, excluded };
}

/** The notice printed (stderr) when specs are skipped. Same text everywhere. */
export function quarantineSkipNotice(excluded: string[]): string {
    return (
        `  Skipping ${excluded.length} quarantined spec(s): ${excluded.join(", ")} ` +
        "(raiken test --only-flaky runs them).\n"
    );
}
