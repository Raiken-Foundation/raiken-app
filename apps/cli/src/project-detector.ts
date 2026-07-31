import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// Type Definitions
// ============================================================================

export type ProjectType = "nextjs" | "react" | "vue" | "svelte" | "vite" | "monorepo" | "generic";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type TestFramework = "playwright" | "cypress" | "vitest" | "jest" | "none";

interface PackageJson {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    workspaces?: string[] | { packages?: string[] };
}

export interface ProjectInfo {
    name: string;
    type: ProjectType;
    packageManager: PackageManager;
    testDir: string;
    testFramework: TestFramework;
    /**
     * True if Playwright looks set up at all — either the npm package is a
     * dependency OR a `playwright.config.*` file exists. Used for framework
     * detection and "probably already installed" defaults; NOT sufficient
     * to assume `npx playwright test` will actually run (see
     * `hasPlaywrightPackage`).
     */
    hasPlaywright: boolean;
    /**
     * True only if `@playwright/test` (or the legacy `playwright` package)
     * is an actual dependency. A project can have `hasPlaywright: true`
     * (a config file exists) while this is `false` — e.g. `node_modules`
     * was wiped, or the config was committed before `npm install` ever
     * ran. `raiken init` uses this specifically to decide whether it needs
     * to install the package before generating an example test that
     * imports it.
     */
    hasPlaywrightPackage: boolean;
    hasJest: boolean;
    hasVitest: boolean;
    hasCypress: boolean;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    rootDir: string;
    isMonorepo: boolean;
    /**
     * Best-effort `testDir`/`baseURL` scraped from an existing
     * `playwright.config.*`, if one exists. When `testDir` is present,
     * `detectProject` uses it instead of the static per-framework guess —
     * otherwise `raiken.config.json`'s `testDirectory` (which the agent
     * uses for every save/read of a test file) can silently diverge from
     * where Playwright itself actually looks.
     */
    existingPlaywrightConfig: { testDir?: string; baseURL?: string } | null;
    /**
     * Dev-server port chosen by the user during `raiken init` when no port
     * could be detected from config files. Undefined = detect/default as usual.
     */
    devServerPort?: number;
}

// ============================================================================
// Main Detection Function
// ============================================================================

export async function detectProject(projectPath: string): Promise<ProjectInfo> {
    // Load package.json
    const packageJson = await loadPackageJson(projectPath);

    // Extract with safe defaults
    const projectName = packageJson.name || path.basename(projectPath);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    const scripts = packageJson.scripts || {};
    const allDeps = { ...dependencies, ...devDependencies };

    // Check if this is a monorepo
    const isMonorepo = await detectIsMonorepo(projectPath, packageJson);

    // Detect project type (needed for test directory)
    const projectType = detectProjectType(allDeps, isMonorepo);

    // Detect package manager
    const packageManager = await detectPackageManager(projectPath);

    // Detect test frameworks from dependencies
    const hasPlaywrightPackage = !!(allDeps.playwright || allDeps["@playwright/test"]);
    const hasJest = !!(allDeps.jest || allDeps["@types/jest"]);
    const hasVitest = !!allDeps.vitest;
    const hasCypress = !!allDeps.cypress;

    // Also check for config files (even if package not installed)
    const existingPlaywrightConfig = await detectExistingPlaywrightConfig(projectPath);
    const hasPlaywright = hasPlaywrightPackage || existingPlaywrightConfig !== null;

    // Prefer the real testDir from an existing playwright.config.* over the
    // static per-framework guess — otherwise raiken.config.json's
    // testDirectory can point somewhere Playwright itself doesn't.
    const testDir = existingPlaywrightConfig?.testDir ?? getDefaultTestDirectory(projectType);

    const testFramework = detectTestFramework({
        hasPlaywright,
        hasJest,
        hasVitest,
        hasCypress,
    });

    return {
        name: projectName,
        type: projectType,
        packageManager,
        testDir,
        testFramework,
        hasPlaywright,
        hasPlaywrightPackage,
        hasJest,
        hasVitest,
        hasCypress,
        scripts,
        dependencies,
        devDependencies,
        rootDir: projectPath,
        isMonorepo,
        existingPlaywrightConfig,
    };
}

function detectProjectType(dependencies: Record<string, string>, isMonorepo: boolean): ProjectType {
    // Monorepo takes precedence
    if (isMonorepo) return "monorepo";

    // Check for specific frameworks (order matters)
    if (dependencies.next) return "nextjs";
    if (dependencies["@sveltejs/kit"] || dependencies.svelte) return "svelte";
    if (dependencies.vue) return "vue";
    if (dependencies.react || dependencies["react-dom"]) return "react";
    if (dependencies.vite) return "vite";

    return "generic";
}

// ============================================================================
// Helper Functions
// ============================================================================

async function loadPackageJson(projectPath: string): Promise<PackageJson> {
    const packageJsonPath = path.join(projectPath, "package.json");

    try {
        const content = await fs.readFile(packageJsonPath, "utf-8");
        return JSON.parse(content);
    } catch (error) {
        throw new Error(
            `Failed to load package.json from ${projectPath}: ${
                error instanceof Error ? error.message : "Unknown error"
            }`,
        );
    }
}

async function detectIsMonorepo(projectPath: string, packageJson: PackageJson): Promise<boolean> {
    // Check package.json workspaces
    if (packageJson.workspaces) {
        const workspaces = packageJson.workspaces;
        if (Array.isArray(workspaces) && workspaces.length > 0) {
            return true;
        }
        if (!Array.isArray(workspaces) && workspaces.packages && workspaces.packages.length > 0) {
            return true;
        }
    }

    // Check for common monorepo configuration files
    const monorepoFiles = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "rush.json"];

    for (const file of monorepoFiles) {
        try {
            await fs.access(path.join(projectPath, file));
            return true;
        } catch {
            // Continue checking
        }
    }

    return false;
}

function detectTestFramework(frameworks: {
    hasPlaywright: boolean;
    hasJest: boolean;
    hasVitest: boolean;
    hasCypress: boolean;
}): TestFramework {
    // Priority: Playwright > Cypress > Vitest > Jest > None
    if (frameworks.hasPlaywright) return "playwright";
    if (frameworks.hasCypress) return "cypress";
    if (frameworks.hasVitest) return "vitest";
    if (frameworks.hasJest) return "jest";
    return "none";
}

const PLAYWRIGHT_CONFIG_FILENAMES = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs",
];

/**
 * Best-effort scrape of `testDir`/`use.baseURL` out of an existing
 * `playwright.config.*`, or `null` if none of the standard filenames exist.
 *
 * We can't safely `import()`/`require()` the file (it may pull in
 * workspace-only or ESM-only packages that fail outside the project's own
 * build), so — same tactic as `detectDevServerPort`'s Vite-config reader —
 * this uses a forgiving regex against the raw source instead of executing
 * it. Returns `{}` (config found, nothing extractable) rather than `null`
 * when the file exists but doesn't match the expected shape, so callers can
 * still tell "Playwright is already set up here" from "no config at all".
 */
async function detectExistingPlaywrightConfig(
    projectPath: string,
): Promise<{ testDir?: string; baseURL?: string } | null> {
    for (const file of PLAYWRIGHT_CONFIG_FILENAMES) {
        let content: string;
        try {
            content = await fs.readFile(path.join(projectPath, file), "utf-8");
        } catch {
            continue;
        }

        const testDirMatch = content.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
        // `use: { ... baseURL: '...' ... }` — same nested-block approach as
        // detectViteConfigPort's `server: { ... }` scan.
        const useBlock = content.match(/use\s*:\s*\{([\s\S]*?)\n\s*\}/);
        const baseURLMatch = useBlock?.[1]?.match(/baseURL\s*:\s*['"]([^'"]+)['"]/);

        const testDir = testDirMatch
            ? testDirMatch[1].replace(/^\.\//, "").replace(/\/$/, "")
            : undefined;
        const baseURL = baseURLMatch?.[1];

        return { ...(testDir ? { testDir } : {}), ...(baseURL ? { baseURL } : {}) };
    }

    return null;
}

async function detectPackageManager(projectPath: string): Promise<PackageManager> {
    // Check for lock files (order matters - most specific first)
    const lockFiles: Array<{ file: string; manager: PackageManager }> = [
        { file: "bun.lockb", manager: "bun" },
        { file: "pnpm-lock.yaml", manager: "pnpm" },
        { file: "yarn.lock", manager: "yarn" },
        { file: "package-lock.json", manager: "npm" },
    ];

    for (const { file, manager } of lockFiles) {
        try {
            await fs.access(path.join(projectPath, file));
            return manager;
        } catch {
            // Continue to next lock file
        }
    }

    return "npm"; // Default fallback
}

function getDefaultTestDirectory(projectType: ProjectType): string {
    // Simple defaults based on framework conventions
    const defaults: Record<ProjectType, string> = {
        nextjs: "e2e",
        react: "tests",
        vue: "tests",
        svelte: "tests",
        vite: "tests",
        monorepo: "tests",
        generic: "tests",
    };

    return defaults[projectType];
}
