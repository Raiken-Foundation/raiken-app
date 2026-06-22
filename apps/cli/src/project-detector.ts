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
    hasPlaywright: boolean;
    hasJest: boolean;
    hasVitest: boolean;
    hasCypress: boolean;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    rootDir: string;
    isMonorepo: boolean;
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

    // Get default test directory
    const testDir = getDefaultTestDirectory(projectType);

    // Detect test frameworks from dependencies
    let hasPlaywright = !!(allDeps.playwright || allDeps["@playwright/test"]);
    const hasJest = !!(allDeps.jest || allDeps["@types/jest"]);
    const hasVitest = !!allDeps.vitest;
    const hasCypress = !!allDeps.cypress;

    // Also check for config files (even if package not installed)
    if (!hasPlaywright) {
        hasPlaywright = await hasPlaywrightConfig(projectPath);
    }

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
        hasJest,
        hasVitest,
        hasCypress,
        scripts,
        dependencies,
        devDependencies,
        rootDir: projectPath,
        isMonorepo,
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

async function hasPlaywrightConfig(projectPath: string): Promise<boolean> {
    // Check for Playwright config files
    const configFiles = [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mjs",
        "playwright.config.cjs",
    ];

    for (const file of configFiles) {
        try {
            await fs.access(path.join(projectPath, file));
            return true;
        } catch {
            // Continue checking
        }
    }

    return false;
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
