export interface TestSavePathParts {
    fileName: string;
    testDir?: string;
}

/** Split a project-relative test path consistently across CLI and dashboard saves. */
export function splitTestSavePath(
    relativePath: string,
    defaultDirectory?: string,
): TestSavePathParts {
    const normalized = relativePath.replaceAll("\\", "/");
    const lastSlash = normalized.lastIndexOf("/");
    return {
        fileName: lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized,
        testDir: lastSlash >= 0 ? normalized.slice(0, lastSlash) : defaultDirectory,
    };
}
