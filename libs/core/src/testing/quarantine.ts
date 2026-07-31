/**
 * Flaky-test quarantine partitioning.
 *
 * The quarantine list lives in `raiken.config.json` (`quarantine.testFiles`)
 * and holds project-relative spec paths (`e2e/login.spec.ts`). A bare
 * filename (`login.spec.ts`) matches any spec with that name so the list
 * stays valid when a spec moves folders. Pure + exported for unit tests.
 */

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when `specPath` (project-relative) is on the quarantine list. */
export function isQuarantinedSpec(specPath: string, quarantined: string[]): boolean {
    const target = normalizeSlashes(specPath);
    return quarantined.some((entry) => {
        const needle = normalizeSlashes(entry.trim());
        if (!needle) return false;
        return target === needle || target.endsWith(`/${needle}`);
    });
}

/**
 * Split suite specs into the runnable set and the quarantined set,
 * preserving input order in both.
 */
export function partitionQuarantinedSpecs(
    specPaths: string[],
    quarantined: string[],
): { included: string[]; excluded: string[] } {
    const included: string[] = [];
    const excluded: string[] = [];
    for (const specPath of specPaths) {
        if (isQuarantinedSpec(specPath, quarantined)) excluded.push(specPath);
        else included.push(specPath);
    }
    return { included, excluded };
}
