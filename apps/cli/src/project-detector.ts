import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Type Definitions
// ============================================================================

export type ProjectType = 'nextjs' | 'react' | 'vue' | 'svelte' | 'vite' | 'generic';
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';
export type TestFramework = 'playwright' | 'cypress' | 'vitest' | 'jest' | 'none';

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
}

// ============================================================================
// Simple Cache (5 minute TTL)
// ============================================================================

interface CachedProjectInfo {
  info: ProjectInfo;
  timestamp: number;
}

const projectCache = new Map<string, CachedProjectInfo>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedProjectInfo(projectPath: string): ProjectInfo | null {
  const cached = projectCache.get(projectPath);
  if (!cached) return null;
  
  const isExpired = Date.now() - cached.timestamp > CACHE_TTL;
  if (isExpired) {
    projectCache.delete(projectPath);
    return null;
  }
  
  return cached.info;
}

function setCachedProjectInfo(projectPath: string, info: ProjectInfo): void {
  projectCache.set(projectPath, {
    info,
    timestamp: Date.now()
  });
}

export function clearProjectCache(projectPath?: string): void {
  if (projectPath) {
    projectCache.delete(projectPath);
  } else {
    projectCache.clear();
  }
}

// ============================================================================
// Main Detection Function
// ============================================================================

export async function detectProject(projectPath: string, useCache = true): Promise<ProjectInfo> {
  // Check cache
  if (useCache) {
    const cached = getCachedProjectInfo(projectPath);
    if (cached) return cached;
  }
  
  // Load package.json
  const packageJson = await loadPackageJson(projectPath);
  const projectName = packageJson.name || path.basename(projectPath);
  const dependencies = packageJson.dependencies || {};
  const devDependencies = packageJson.devDependencies || {};
  const scripts = packageJson.scripts || {};
  const allDeps = { ...dependencies, ...devDependencies };

  // Detect everything
  const projectType = detectProjectType(allDeps);
  const packageManager = await detectPackageManager(projectPath);
  const testDir = getDefaultTestDirectory(projectType);
  
  // Detect test frameworks
  const hasPlaywright = !!(allDeps['playwright'] || allDeps['@playwright/test']);
  const hasJest = !!(allDeps['jest'] || allDeps['@types/jest']);
  const hasVitest = !!(allDeps['vitest']);
  const hasCypress = !!(allDeps['cypress']);

  const testFramework = detectTestFramework({
    hasPlaywright,
    hasJest,
    hasVitest,
    hasCypress
  });

  const projectInfo: ProjectInfo = {
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
    rootDir: projectPath
  };
  
  // Cache it
  if (useCache) {
    setCachedProjectInfo(projectPath, projectInfo);
  }
  
  return projectInfo;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function loadPackageJson(projectPath: string): Promise<Record<string, any>> {
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function detectProjectType(dependencies: Record<string, string>): ProjectType {
  // Check for specific frameworks (order matters)
  if (dependencies['next']) return 'nextjs';
  if (dependencies['@sveltejs/kit'] || dependencies['svelte']) return 'svelte';
  if (dependencies['vue']) return 'vue';
  if (dependencies['react'] || dependencies['react-dom']) return 'react';
  if (dependencies['vite']) return 'vite';
  
  return 'generic';
}

function detectTestFramework(frameworks: {
  hasPlaywright: boolean;
  hasJest: boolean;
  hasVitest: boolean;
  hasCypress: boolean;
}): TestFramework {
  // Priority: Playwright > Cypress > Vitest > Jest > None
  if (frameworks.hasPlaywright) return 'playwright';
  if (frameworks.hasCypress) return 'cypress';
  if (frameworks.hasVitest) return 'vitest';
  if (frameworks.hasJest) return 'jest';
  return 'none';
}

async function detectPackageManager(projectPath: string): Promise<PackageManager> {
  // Check for lock files
  const lockFiles: Array<{ file: string; manager: PackageManager }> = [
    { file: 'bun.lockb', manager: 'bun' },
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' }
  ];

  for (const { file, manager } of lockFiles) {
    try {
      await fs.access(path.join(projectPath, file));
      return manager;
    } catch {
      continue;
    }
  }

  return 'npm';
}

function getDefaultTestDirectory(projectType: ProjectType): string {
  // Simple defaults based on framework conventions
  const defaults: Record<ProjectType, string> = {
    nextjs: 'e2e',
    react: 'tests',
    vue: 'tests',
    svelte: 'tests',
    vite: 'tests',
    generic: 'tests'
  };

  return defaults[projectType];
}

