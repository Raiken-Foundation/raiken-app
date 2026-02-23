import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { select, confirm, input } from '@inquirer/prompts';
import { createConfig } from '@raiken/shared';
import { detectProject, type ProjectInfo, type ProjectType, type TestFramework } from './project-detector';

interface UserPreferences {
  projectType: ProjectType;
  testFramework: TestFramework;
  testDirectory: string;
  installPlaywright: boolean;
  generateExampleTest: boolean;
}

async function promptUserPreferences(projectInfo: ProjectInfo): Promise<UserPreferences> {
  console.log(chalk.cyan('\n🔍 Detected project information:'));
  console.log(chalk.gray(`   Project: ${projectInfo.name}`));
  console.log(chalk.gray(`   Type: ${projectInfo.type}`));
  console.log(chalk.gray(`   Test Framework: ${projectInfo.testFramework}`));
  console.log(chalk.gray(`   Package Manager: ${projectInfo.packageManager}`));
  
  // Determine what needs to be asked
  const needsProjectType = projectInfo.type === 'generic';
  const needsTestFramework = projectInfo.testFramework === 'none';
  const everythingDetected = !needsProjectType && !needsTestFramework;
  
  // If everything is detected, ask if user wants to use auto-detected config
  if (everythingDetected) {
    console.log(chalk.green('\n✓ Auto-detected project configuration.'));
    console.log(chalk.gray(`   ${projectInfo.type} + ${projectInfo.testFramework} → ${projectInfo.testDir}/\n`));
    
    const useDetected = await confirm({
      message: 'Use auto-detected configuration?',
      default: true
    });
    
    if (useDetected) {
      // Use all detected values, only ask about installation preferences
      let installPlaywright = false;
      let generateExampleTest = false;
      
      if (projectInfo.testFramework === 'playwright') {
        installPlaywright = await confirm({
          message: 'Install Playwright browsers now?',
          default: !projectInfo.hasPlaywright
        });
      }
      
      if (projectInfo.testFramework !== 'none') {
        generateExampleTest = await confirm({
          message: 'Generate an example test file?',
          default: true
        });
      }
      
      return {
        projectType: projectInfo.type,
        testFramework: projectInfo.testFramework,
        testDirectory: projectInfo.testDir,
        installPlaywright,
        generateExampleTest
      };
    }
    
    console.log(chalk.yellow('\n📋 Customizing configuration...\n'));
  } else {
    console.log(chalk.yellow('\n⚠️  Some information could not be auto-detected.\n'));
  }

  let projectType: ProjectType = projectInfo.type;
  let testFramework: TestFramework = projectInfo.testFramework;
  
  // Only prompt for project type if we couldn't detect it
  if (needsProjectType) {
    projectType = await select<ProjectType>({
      message: 'What UI framework/library is your project using?',
      choices: [
        { name: 'Next.js', value: 'nextjs' },
        { name: 'React', value: 'react' },
        { name: 'Vue', value: 'vue' },
        { name: 'Svelte', value: 'svelte' },
        { name: 'Vite', value: 'vite' },
        { name: 'Generic/Other', value: 'generic' }
      ],
      default: 'generic'
    });
  } else {
    console.log(chalk.gray(`   Using detected type: ${projectInfo.type}`));
  }

  // Only prompt for test framework if none is detected
  if (needsTestFramework) {
    testFramework = await select<TestFramework>({
      message: 'Which E2E test framework would you like to use?',
      choices: [
        { 
          name: 'Playwright (Recommended for Raiken)', 
          value: 'playwright',
          description: 'Modern, fast, and reliable E2E testing'
        },
        { 
          name: 'Cypress', 
          value: 'cypress',
          description: 'Popular E2E testing framework'
        },
        { 
          name: 'Vitest', 
          value: 'vitest',
          description: 'Fast unit test framework with E2E support'
        },
        { 
          name: 'Jest', 
          value: 'jest',
          description: 'Traditional JavaScript testing framework'
        },
        { 
          name: 'None (Setup later)', 
          value: 'none',
          description: 'Skip test framework setup for now'
        }
      ],
      default: 'playwright'
    });
  } else {
    console.log(chalk.gray(`   Using detected test framework: ${projectInfo.testFramework}`));
  }

  // Always ask for test directory confirmation (quick, low friction)
  const testDirectory = await input({
    message: 'Where should E2E tests be stored?',
    default: projectInfo.testDir,
    validate: async (value) => {
      if (!value || value.trim() === '') {
        return 'Test directory cannot be empty';
      }

      // Basic validation
      if (value.includes('..') || value.startsWith('/')) {
        return 'Please use a relative path without ".." or leading "/"';
      }

      // Path traversal protection using realpath
      try {
        const resolved = await fs.realpath(path.resolve(projectInfo.rootDir, value));
        const root = await fs.realpath(projectInfo.rootDir);

        if (!resolved.startsWith(root)) {
          return 'Test directory must be inside the project';
        }
      } catch {
        // Path doesn't exist yet, which is fine - we'll create it
        // But still check that the normalized path is safe
        const normalized = path.normalize(path.join(projectInfo.rootDir, value));
        const root = path.resolve(projectInfo.rootDir);

        if (!normalized.startsWith(root)) {
          return 'Test directory must be inside the project';
        }
      }

      return true;
    }
  });

  // For Playwright, ask about browser installation (only if Playwright is selected)
  const installPlaywright = testFramework === 'playwright' 
    ? await confirm({
        message: 'Install Playwright browsers now? (Required for running tests)',
        default: !projectInfo.hasPlaywright // Default to yes if not already installed
      })
    : false;

  // Ask about example test generation (only if test framework is selected)
  const generateExampleTest = testFramework !== 'none'
    ? await confirm({
        message: 'Generate an example test file?',
        default: true
      })
    : false;

  return {
    projectType,
    testFramework,
    testDirectory: testDirectory.trim(),
    installPlaywright,
    generateExampleTest
  };
}

// ============================================================================
// Main Initialization Function
// ============================================================================

export async function initializeProject(projectPath: string, force = false): Promise<void> {
  // Step 1: Detect project information
  console.log(chalk.blue('🔎 Analyzing your project...\n'));
  const projectInfo = await detectProject(projectPath);

  // Step 2: Prompt user for preferences
  const preferences = await promptUserPreferences(projectInfo);

  // Merge preferences with project info
  const finalProjectInfo: ProjectInfo = {
    ...projectInfo,
    type: preferences.projectType,
    testFramework: preferences.testFramework,
    testDir: preferences.testDirectory
  };

  console.log(chalk.blue(`\n📁 Setting up ${finalProjectInfo.type} project: ${finalProjectInfo.name}\n`));

  try {
    // Step 3: Create .raiken directory and database structure
    await initializeRaikenDirectory(projectPath);

    // Step 4: Update .gitignore to exclude .raiken
    await updateGitignore(projectPath);

    // Step 5: Create test directory
    await createTestDirectory(projectPath, finalProjectInfo);

    // Step 6: Create test-results directory structure
    await createTestResultsDirectory(projectPath);

    // Step 7: Create Raiken configuration
    await createRaikenConfig(projectPath, finalProjectInfo, force);

    // Step 8: Set up test framework configuration (if applicable)
    if (preferences.testFramework === 'playwright') {
      await setupPlaywrightConfig(projectPath, finalProjectInfo, force);
    } else if (preferences.testFramework !== 'none') {
      console.log(chalk.yellow(`⚠️  Manual setup required for ${preferences.testFramework}`));
      console.log(chalk.gray(`   Raiken works best with Playwright. Consider switching later.\n`));
    }

    // Step 9: Update package.json scripts
    await updatePackageScripts(projectPath, finalProjectInfo, preferences.testFramework);

    // Step 10: Create example test (if requested)
    if (preferences.generateExampleTest) {
        await createExampleTest(projectPath, finalProjectInfo);
    }

    // Step 11: Install Playwright browsers (if requested)
    if (preferences.installPlaywright) {
      await installPlaywrightBrowsers(projectPath, finalProjectInfo);
    }

  // Success message
  console.log(chalk.green('\n✅ Project initialization complete!'));
  console.log(chalk.cyan('\nNext steps:'));
  console.log(chalk.gray('  1. Run "raiken start" to launch the dashboard'));
  console.log(chalk.gray('  2. Open http://localhost:7101 in your browser'));
  console.log(chalk.gray('  3. Start generating AI-powered tests!\n'));

  // Additional info based on choices
  if (!preferences.installPlaywright && preferences.testFramework === 'playwright') {
    console.log(chalk.yellow('⚠️  Remember to install Playwright browsers:'));
    console.log(chalk.gray('   npx playwright install\n'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.red(`\n❌ Setup failed: ${message}`));
    console.log(chalk.yellow('\n💡 Tip: You can safely re-run "raiken init" to try again.'));
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function checkFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getExampleTestFilename(testFramework: TestFramework): string {
  switch (testFramework) {
    case 'playwright':
      return 'example.spec.ts';
    case 'cypress':
      return 'example.cy.ts';
    case 'vitest':
    case 'jest':
      return 'example.test.ts';
    default:
      return 'example.test.js';
  }
}

async function initializeRaikenDirectory(projectPath: string): Promise<void> {
  const raikenDirPath = path.join(projectPath, '.raiken');
  
    await fs.mkdir(raikenDirPath, { recursive: true });
    console.log(chalk.green('✓ Created .raiken/ directory'));
    
    // Create a README to explain the directory
    const readmePath = path.join(raikenDirPath, 'README.md');
    const readmeContent = `# Raiken Local Database

This directory contains Raiken's local state and database files.

**Do not commit this directory to version control.**

Files in this directory:
- \`raiken.db\` - SQLite database with project context and test history
- \`cache/\` - Cached embeddings and analysis results

This directory is automatically added to .gitignore during initialization.
`;
    
    await fs.writeFile(readmePath, readmeContent);
    
    // Create cache subdirectory
    await fs.mkdir(path.join(raikenDirPath, 'cache'), { recursive: true });
}

async function updateGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  
    let gitignoreContent = '';
    
    try {
      gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // .gitignore doesn't exist, will create it
    }
    
    const hasRaiken = gitignoreContent.includes(".raiken/");
    const hasCrawleeStorage = gitignoreContent.includes("storage/");

    if (!hasRaiken || !hasCrawleeStorage) {
      let raikenSection = "\n# Raiken local database\n.raiken/\n";
      if (!hasCrawleeStorage) {
        raikenSection += "# Crawlee storage (site discovery)\nstorage/\n";
      }
      if (!hasRaiken) {
        gitignoreContent += raikenSection;
      } else if (!hasCrawleeStorage) {
        gitignoreContent += `\n# Crawlee storage (site discovery)\nstorage/\n`;
      }
      await fs.writeFile(gitignorePath, gitignoreContent);
      console.log(chalk.green("✓ Updated .gitignore to exclude Raiken artifacts"));
    } else {
      console.log(chalk.gray("  .gitignore already excludes Raiken artifacts"));
    }
}

async function createTestDirectory(projectPath: string, projectInfo: ProjectInfo): Promise<void> {
  const testDirPath = path.join(projectPath, projectInfo.testDir);

    await fs.mkdir(testDirPath, { recursive: true });
    console.log(chalk.green(`✓ Created test directory: ${projectInfo.testDir}/`));
}

async function createTestResultsDirectory(projectPath: string): Promise<void> {
  const testResultsPath = path.join(projectPath, 'test-results');
  const testReportsPath = path.join(projectPath, 'test-reports');

    // Create test-results directory (for Playwright artifacts)
      await fs.mkdir(testResultsPath, { recursive: true });

    // Create test-reports directory (for Raiken reports - separate from Playwright)
      await fs.mkdir(testReportsPath, { recursive: true });
    
    // Create .gitignore in test-results to exclude Playwright artifacts
    const testResultsGitignorePath = path.join(testResultsPath, '.gitignore');
    const testResultsGitignoreContent = `# Playwright test artifacts
*
!.gitignore
`;
    
  const testResultsGitignoreExists = await checkFileExists(testResultsGitignorePath);
  if (!testResultsGitignoreExists) {
      await fs.writeFile(testResultsGitignorePath, testResultsGitignoreContent);
      console.log(chalk.green('✓ Created test-results/.gitignore'));
    }
    
    // Create .gitignore in test-reports to exclude report JSON files
    const testReportsGitignorePath = path.join(testReportsPath, '.gitignore');
    const testReportsGitignoreContent = `# Test report JSON files
*.json
`;
    
  const testReportsGitignoreExists = await checkFileExists(testReportsGitignorePath);
  if (!testReportsGitignoreExists) {
      await fs.writeFile(testReportsGitignorePath, testReportsGitignoreContent);
      console.log(chalk.green('✓ Created test-reports/.gitignore'));
    }
    
    console.log(chalk.green('✓ Created test-results/ and test-reports/ directories'));
}

async function createRaikenConfig(projectPath: string, projectInfo: ProjectInfo, force: boolean): Promise<void> {
  const configPath = path.join(projectPath, 'raiken.config.json');
  
  // Use shared config with project-specific overrides
  const config = createConfig({
    projectType: projectInfo.type,
    testDirectory: projectInfo.testDir
  });
  
  try {
    await fs.access(configPath);
    if (!force) {
      console.log(chalk.yellow('⚠ raiken.config.json already exists (use --force to overwrite)'));
      return;
    }
  } catch {
    // File doesn't exist, proceed
  }
  
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(chalk.green('✓ Created raiken.config.json'));
}

async function setupPlaywrightConfig(projectPath: string, projectInfo: ProjectInfo, force: boolean): Promise<void> {
  const configPath = path.join(projectPath, 'playwright.config.ts');
  
  const config = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './${projectInfo.testDir}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  preserveOutput: 'always',
  use: {
    baseURL: 'http://localhost:${getDefaultPort(projectInfo.type)}',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Additional browsers can be enabled by uncommenting:
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],
  webServer: {
    command: '${getDevCommand(projectInfo)}',
    port: ${getDefaultPort(projectInfo.type)},
    reuseExistingServer: !process.env.CI,
  },
});
`;
  
  try {
    await fs.access(configPath);
    if (!force) {
      console.log(chalk.yellow('⚠ playwright.config.ts already exists (use --force to overwrite)'));
      return;
    }
  } catch {
    // File doesn't exist, proceed
  }
  
  await fs.writeFile(configPath, config);
  console.log(chalk.green('✓ Created playwright.config.ts'));
}

async function updatePackageScripts(
  projectPath: string, 
  _projectInfo: ProjectInfo,
  testFramework: TestFramework
): Promise<void> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  
    const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageContent);
    
    // Base Raiken script
    const newScripts: Record<string, string> = {
      'raiken': 'raiken start'
    };
    
    // Add framework-specific scripts
    switch (testFramework) {
      case 'playwright':
        newScripts['test:e2e'] = 'playwright test';
        newScripts['test:e2e:ui'] = 'playwright test --ui';
        newScripts['test:e2e:debug'] = 'playwright test --debug';
        newScripts['test:e2e:headed'] = 'playwright test --headed';
        break;
      
      case 'cypress':
        newScripts['test:e2e'] = 'cypress run';
        newScripts['test:e2e:open'] = 'cypress open';
        break;
      
      case 'vitest':
        newScripts['test:e2e'] = 'vitest run';
        newScripts['test:e2e:watch'] = 'vitest watch';
        break;
      
      case 'jest':
        newScripts['test:e2e'] = 'jest';
        newScripts['test:e2e:watch'] = 'jest --watch';
        break;
      
      case 'none':
        // Only add raiken script
        break;
    }
    
    // Only add scripts that don't already exist with the same command
    packageJson.scripts = packageJson.scripts || {};
    for (const [name, command] of Object.entries(newScripts)) {
      if (packageJson.scripts[name] !== command) {
        packageJson.scripts[name] = command;
      }
    }
    
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log(chalk.green('✓ Updated package.json scripts'));
}

async function createExampleTest(projectPath: string, projectInfo: ProjectInfo): Promise<void> {
  const fileName = getExampleTestFilename(projectInfo.testFramework);
  const testPath = path.join(projectPath, projectInfo.testDir, fileName);
  
  // Check if file already exists
  if (await checkFileExists(testPath)) {
    console.log(chalk.gray(`  Example test already exists: ${projectInfo.testDir}/${fileName}`));
    return;
  }
  
  let exampleTest = '';
  
  switch (projectInfo.testFramework) {
    case 'playwright':
      exampleTest = `import { test, expect } from '@playwright/test';

test('example test - home page loads', async ({ page }) => {
  // Navigate to your application
  await page.goto('/');
  
  // Example: Check if the page loads successfully
  await expect(page).toHaveTitle(/.*${projectInfo.name}.*/i);
  
  // Add your test steps here:
  // await page.click('button[data-testid="my-button"]');
  // await expect(page.getByText('Success!')).toBeVisible();
});

test('example test - navigation works', async ({ page }) => {
  await page.goto('/');
  
  // Test navigation or interactions
  // await page.click('a[href="/about"]');
  // await expect(page).toHaveURL(/.*about/);
});
`;
      break;
      
    case 'cypress':
      exampleTest = `describe('Example Test Suite', () => {
  it('should load the home page', () => {
    cy.visit('/');
    cy.title().should('contain', '${projectInfo.name}');
  });

  it('should navigate and interact', () => {
    cy.visit('/');
    
    // Add your test steps here:
    // cy.get('button[data-testid="my-button"]').click();
    // cy.contains('Success!').should('be.visible');
  });
});
`;
      break;
      
    case 'vitest':
      exampleTest = `import { describe, it, expect } from 'vitest';

describe('Example Test Suite', () => {
  it('should pass basic assertion', () => {
    expect(true).toBe(true);
  });

  it('should test your functions', () => {
    // Add your test logic here
    const result = 1 + 1;
    expect(result).toBe(2);
  });
});
`;
      break;
      
    case 'jest':
      exampleTest = `describe('Example Test Suite', () => {
  it('should pass basic assertion', () => {
    expect(true).toBe(true);
  });

  it('should test your functions', () => {
    // Add your test logic here
    const result = 1 + 1;
    expect(result).toBe(2);
  });
});
`;
      break;
      
    default:
      console.log(chalk.gray('  Skipping example test generation'));
      return;
  }
  
  await fs.writeFile(testPath, exampleTest);
  console.log(chalk.green(`✓ Created example test: ${projectInfo.testDir}/${fileName}`));
}

function getDefaultPort(projectType: string): number {
  switch (projectType) {
    case 'nextjs':
    case 'react':
    case 'nuxt':
      return 3000;
    case 'svelte':
    case 'vite':
      return 5173;
    case 'angular':
      return 4200;
    default:
      return 3000;
  }
}

function getDevCommand(projectInfo: ProjectInfo): string {
  // Determine the package manager command
  const runCommand = projectInfo.packageManager === 'npm' 
    ? 'npm run' 
    : projectInfo.packageManager;
  
  // Find the appropriate dev script
  if (projectInfo.scripts.dev) return `${runCommand} dev`;
  if (projectInfo.scripts.start) return `${runCommand} start`;
  if (projectInfo.scripts.serve) return `${runCommand} serve`;
  
  // Fallback to dev
  return `${runCommand} dev`;
}

async function installPlaywrightBrowsers(projectPath: string, projectInfo: ProjectInfo): Promise<void> {
  // Only install browsers if Playwright is already a dependency
  if (!projectInfo.hasPlaywright) {
    console.log(chalk.yellow('⚠ Playwright not detected as dependency, skipping browser installation'));
    return;
  }

  console.log(chalk.blue('📦 Installing Playwright browsers...'));

  try {

    // Use Promise.race to implement timeout
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['playwright', 'install'], {
          cwd: projectPath,
          stdio: 'inherit' // Show output to user
        });

        child.on('close', (code: number) => {
          if (code === 0) {
            console.log(chalk.green('✓ Playwright browsers installed successfully'));
            resolve();
          } else {
            console.log(chalk.yellow(`⚠ Playwright install failed (exit code ${code})`));
            reject(new Error(`Playwright install exited with code ${code}`));
          }
        });

        child.on('error', (error: Error) => {
          console.log(chalk.yellow('⚠ Failed to start Playwright installation'));
          reject(new Error(`Failed to start Playwright install: ${error.message}`));
        });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          console.log(chalk.yellow('⚠ Playwright browser installation timed out'));
          reject(new Error('Playwright browser installation timed out after 2 minutes'));
        }, 120000)
      )
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.yellow(`⚠ Playwright browser installation failed: ${message}`));
    console.log(chalk.gray('  You can install them manually with: npx playwright install'));
    // Don't re-throw - this is not critical for setup completion
  }
} 