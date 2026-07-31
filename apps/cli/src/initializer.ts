import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import {
    type AIProviderId,
    detectDevServerPort,
    listProviders,
    writeConfigAtomic,
} from "@raiken/core";
import { createConfig } from "@raiken/shared/server";
import chalk from "chalk";
import {
    detectProject,
    type PackageManager,
    type ProjectInfo,
    type ProjectType,
    type TestFramework,
} from "./project-detector";

/**
 * Which AI provider (if any) has a usable key sitting in the environment
 * already. `raiken.config.json` always defaulted `ai.provider` to
 * `"openrouter"` regardless of what was actually set — so a user with only
 * `ANTHROPIC_API_KEY` in their shell would run `init`, get a config that
 * checks for `OPENROUTER_API_KEY`, and see "no AI key configured" even
 * though they have a perfectly usable key for a different provider. Checked
 * in `listProviders()` order, which puts `openrouter` (Raiken's own
 * default) first — so if both are set, the default provider wins and we
 * don't switch out from under an intentional choice.
 */
export function detectAIProviderFromEnv(): { provider: AIProviderId; envVar: string } | null {
    for (const provider of listProviders()) {
        // "custom" requires a user-supplied baseURL we have no way to infer
        // (its default is ""); auto-selecting it from the generic
        // AI_API_KEY fallback would produce a config that can't actually
        // reach anything, which is worse than leaving it on openrouter.
        if (provider.id === "custom") continue;
        for (const envVar of provider.envVars) {
            if (process.env[envVar]?.trim()) {
                return { provider: provider.id, envVar };
            }
        }
    }
    return null;
}

interface UserPreferences {
    projectType: ProjectType;
    testFramework: TestFramework;
    testDirectory: string;
    installPlaywright: boolean;
    generateExampleTest: boolean;
    /** Chosen interactively when no port could be detected; undefined = auto-detect. */
    devServerPort?: number;
}

/** Sentinel fallback so we can tell "found in project config" from "defaulted". */
const PORT_NOT_DETECTED = -1;

/**
 * Ask which port the dev server listens on — only worth asking when Playwright
 * will get a `webServer` block AND no port could be scraped from the project's
 * own config (vite.config, angular.json, --port flag). When detection already
 * succeeded we trust it silently; bug class this prevents: init hardcodes
 * 3000 for an app that actually runs elsewhere, and the first `raiken test`
 * dies with an opaque webServer error.
 */
async function askDevServerPort(
    projectPath: string,
    projectInfo: ProjectInfo,
    resolvedType: ProjectType,
    resolvedFramework: TestFramework,
): Promise<number | undefined> {
    if (resolvedFramework !== "playwright") return undefined;
    if (!getDevCommand(projectInfo)) return undefined;
    const detected = await detectDevServerPort(projectPath, PORT_NOT_DETECTED);
    if (detected !== PORT_NOT_DETECTED) return undefined;

    const answer = await input({
        message: "Which port does your dev server listen on?",
        default: String(getDefaultPort(resolvedType)),
        validate: (value) => {
            const port = Number(value);
            return (
                (Number.isInteger(port) && port > 0 && port < 65536) ||
                "Port must be a whole number between 1 and 65535"
            );
        },
    });
    return Number(answer);
}

/** Inquirer rejects with this when stdin closes mid-prompt (Ctrl+C, no TTY). */
function isPromptCancelled(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === "ExitPromptError" || error.message.includes("force closed"))
    );
}

async function promptUserPreferences(
    projectInfo: ProjectInfo,
    nonInteractive = false,
    projectPath: string = projectInfo.rootDir,
): Promise<UserPreferences> {
    if (!nonInteractive && !process.stdin.isTTY) {
        throw new Error(
            "Init needs answers but can't prompt here (no interactive terminal). " +
                "Re-run with `raiken init -y` to accept the auto-detected defaults.",
        );
    }

    console.log(chalk.cyan("\nDetected project information:"));
    console.log(chalk.gray(`   Project: ${projectInfo.name}`));
    console.log(chalk.gray(`   Type: ${projectInfo.type}`));
    console.log(chalk.gray(`   Test Framework: ${projectInfo.testFramework}`));
    console.log(chalk.gray(`   Package Manager: ${projectInfo.packageManager}`));

    // Determine what needs to be asked
    const needsProjectType = projectInfo.type === "generic";
    const needsTestFramework = projectInfo.testFramework === "none";
    const everythingDetected = !needsProjectType && !needsTestFramework;

    if (nonInteractive) {
        const resolvedType: ProjectType = projectInfo.type;
        const resolvedFramework: Exclude<TestFramework, "none"> =
            projectInfo.testFramework === "none" ? "playwright" : projectInfo.testFramework;
        console.log(chalk.green("\n✓ --yes: accepting auto-detected defaults"));
        console.log(
            chalk.gray(`   ${resolvedType} + ${resolvedFramework} → ${projectInfo.testDir}/\n`),
        );
        return {
            projectType: resolvedType,
            testFramework: resolvedFramework,
            testDirectory: projectInfo.testDir,
            installPlaywright: resolvedFramework === "playwright" && !projectInfo.hasPlaywright,
            generateExampleTest: true,
        };
    }

    // If everything is detected, ask if user wants to use auto-detected config
    if (everythingDetected) {
        console.log(chalk.green("\n✓ Auto-detected project configuration."));
        console.log(
            chalk.gray(
                `   ${projectInfo.type} + ${projectInfo.testFramework} → ${projectInfo.testDir}/\n`,
            ),
        );

        const useDetected = await confirm({
            message: "Use auto-detected configuration?",
            default: true,
        });

        if (useDetected) {
            // Use all detected values, only ask about installation preferences
            let installPlaywright = false;
            let generateExampleTest = false;

            if (projectInfo.testFramework === "playwright") {
                installPlaywright = await confirm({
                    message: "Install Playwright browsers now?",
                    default: !projectInfo.hasPlaywright,
                });
            }

            if (projectInfo.testFramework !== "none") {
                generateExampleTest = await confirm({
                    message: "Generate an example test file?",
                    default: true,
                });
            }

            return {
                projectType: projectInfo.type,
                testFramework: projectInfo.testFramework,
                testDirectory: projectInfo.testDir,
                installPlaywright,
                generateExampleTest,
                devServerPort: await askDevServerPort(
                    projectPath,
                    projectInfo,
                    projectInfo.type,
                    projectInfo.testFramework,
                ),
            };
        }

        console.log(chalk.yellow("\nCustomizing configuration...\n"));
    } else {
        console.log(chalk.yellow("\n⚠ Some information could not be auto-detected.\n"));
    }

    let projectType: ProjectType = projectInfo.type;
    let testFramework: TestFramework = projectInfo.testFramework;

    // Only prompt for project type if we couldn't detect it
    if (needsProjectType) {
        projectType = await select<ProjectType>({
            message: "What UI framework/library is your project using?",
            choices: [
                { name: "Next.js", value: "nextjs" },
                { name: "React", value: "react" },
                { name: "Vue", value: "vue" },
                { name: "Svelte", value: "svelte" },
                { name: "Vite", value: "vite" },
                { name: "Generic/Other", value: "generic" },
            ],
            default: "generic",
        });
    } else {
        console.log(chalk.gray(`   Using detected type: ${projectInfo.type}`));
    }

    // Only prompt for test framework if none is detected
    if (needsTestFramework) {
        testFramework = await select<TestFramework>({
            message: "Which E2E test framework would you like to use?",
            choices: [
                {
                    name: "Playwright (Recommended for Raiken)",
                    value: "playwright",
                    description: "Modern, fast, and reliable E2E testing",
                },
                {
                    name: "Cypress",
                    value: "cypress",
                    description: "Popular E2E testing framework",
                },
                {
                    name: "Vitest",
                    value: "vitest",
                    description: "Fast unit test framework with E2E support",
                },
                {
                    name: "Jest",
                    value: "jest",
                    description: "Traditional JavaScript testing framework",
                },
                {
                    name: "None (Setup later)",
                    value: "none",
                    description: "Skip test framework setup for now",
                },
            ],
            default: "playwright",
        });
    } else {
        console.log(chalk.gray(`   Using detected test framework: ${projectInfo.testFramework}`));
    }

    // Always ask for test directory confirmation (quick, low friction)
    const testDirectory = await input({
        message: "Where should E2E tests be stored?",
        default: projectInfo.testDir,
        validate: async (value) => {
            if (!value || value.trim() === "") {
                return "Test directory cannot be empty";
            }

            // Basic validation
            if (value.includes("..") || value.startsWith("/")) {
                return 'Please use a relative path without ".." or leading "/"';
            }

            // Path traversal protection using realpath
            try {
                const resolved = await fs.realpath(path.resolve(projectInfo.rootDir, value));
                const root = await fs.realpath(projectInfo.rootDir);

                if (!resolved.startsWith(root)) {
                    return "Test directory must be inside the project";
                }
            } catch {
                // Path doesn't exist yet, which is fine - we'll create it
                // But still check that the normalized path is safe
                const normalized = path.normalize(path.join(projectInfo.rootDir, value));
                const root = path.resolve(projectInfo.rootDir);

                if (!normalized.startsWith(root)) {
                    return "Test directory must be inside the project";
                }
            }

            return true;
        },
    });

    // For Playwright, ask about browser installation (only if Playwright is selected)
    const installPlaywright =
        testFramework === "playwright"
            ? await confirm({
                  message: "Install Playwright browsers now? (Required for running tests)",
                  default: !projectInfo.hasPlaywright, // Default to yes if not already installed
              })
            : false;

    // Ask about example test generation (only if test framework is selected)
    const generateExampleTest =
        testFramework !== "none"
            ? await confirm({
                  message: "Generate an example test file?",
                  default: true,
              })
            : false;

    return {
        projectType,
        testFramework,
        testDirectory: testDirectory.trim(),
        installPlaywright,
        generateExampleTest,
        devServerPort: await askDevServerPort(projectPath, projectInfo, projectType, testFramework),
    };
}

// ============================================================================
// Main Initialization Function
// ============================================================================

export interface InitializeProjectOptions {
    force?: boolean;
    nonInteractive?: boolean;
    /** Skip downloading Playwright browser binaries (e.g. on a metered/CI box). */
    skipBrowsers?: boolean;
}

export async function initializeProject(
    projectPath: string,
    options: InitializeProjectOptions | boolean = {},
): Promise<void> {
    // Back-compat: previous signature was `initializeProject(path, force)`.
    const opts: InitializeProjectOptions =
        typeof options === "boolean" ? { force: options } : options;
    const force = opts.force ?? false;
    const nonInteractive = opts.nonInteractive ?? false;
    const skipBrowsers = opts.skipBrowsers ?? false;

    // Check for package.json first
    const pkgPath = path.join(projectPath, "package.json");
    try {
        await fs.access(pkgPath);
    } catch {
        throw new Error(
            'No package.json found in the current directory. Run "raiken init" from your project root.',
        );
    }

    // `init` must fail fast before opening its preference wizard. The REPL and
    // dashboard can create `.raiken/` on first use, so the config file is the
    // reliable signal that the project has actually been initialized.
    const configPath = path.join(projectPath, "raiken.config.json");
    try {
        await fs.access(configPath);
        if (!force) {
            console.log(
                chalk.yellow(
                    "Project already has raiken.config.json. Use --force to re-initialize.",
                ),
            );
            return;
        }
    } catch {
        /* first initialization */
    }

    // Step 1: Detect project information
    console.log(chalk.blue("Analyzing your project...\n"));
    const projectInfo = await detectProject(projectPath);

    // Step 2: Prompt user for preferences
    let preferences: UserPreferences;
    try {
        preferences = await promptUserPreferences(projectInfo, nonInteractive, projectPath);
    } catch (error) {
        if (isPromptCancelled(error)) {
            throw new Error("Init cancelled — nothing was changed.");
        }
        throw error;
    }

    // Merge preferences with project info
    const finalProjectInfo: ProjectInfo = {
        ...projectInfo,
        type: preferences.projectType,
        testFramework: preferences.testFramework,
        testDir: preferences.testDirectory,
        devServerPort: preferences.devServerPort,
    };

    console.log(
        chalk.blue(`\nSetting up ${finalProjectInfo.type} project: ${finalProjectInfo.name}\n`),
    );

    try {
        await initializeRaikenDirectory(projectPath);
        await updateGitignore(projectPath);
        await createTestDirectory(projectPath, finalProjectInfo);
        await createTestResultsDirectory(projectPath);
        await createRaikenConfig(projectPath, finalProjectInfo, force);

        // Tracks whether `@playwright/test` is actually importable, updated
        // below if we install it — `finalProjectInfo.hasPlaywrightPackage`
        // is a point-in-time snapshot from before init ran anything.
        let playwrightPackageReady = finalProjectInfo.hasPlaywrightPackage;

        let webServerConfigured = false;
        if (preferences.testFramework === "playwright") {
            webServerConfigured = await setupPlaywrightConfig(projectPath, finalProjectInfo, force);

            // Pre-fix: init would happily write playwright.config.ts *and*
            // an example test importing '@playwright/test' without ever
            // installing the package — `npx playwright test` (and the
            // agent's own test runs) would fail on
            // "Cannot find module '@playwright/test'" with no indication
            // why, since everything else about setup looked complete.
            if (!playwrightPackageReady) {
                playwrightPackageReady = await installPlaywrightPackage(
                    projectPath,
                    finalProjectInfo,
                );
            }
        } else if (preferences.testFramework !== "none") {
            console.log(chalk.yellow(`⚠ Manual setup required for ${preferences.testFramework}`));
            console.log(
                chalk.gray(`   Raiken works best with Playwright. Consider switching later.\n`),
            );
        }

        await updatePackageScripts(projectPath, finalProjectInfo, preferences.testFramework);

        // Step 10: Create example test (if requested)
        if (preferences.generateExampleTest) {
            await createExampleTest(projectPath, finalProjectInfo);
        }

        // Step 11: Install Playwright browsers (if requested)
        if (preferences.installPlaywright && !skipBrowsers) {
            await installPlaywrightBrowsers(projectPath, playwrightPackageReady);
        }

        // Complete the first-run experience in one place instead of making
        // users infer that `init` and `config` are separate required setup
        // phases. Environment-backed projects are already ready; everyone
        // else can enter the exact same guided flow used by `/config`.
        if (!nonInteractive && !detectAIProviderFromEnv()) {
            const configureAI = await confirm({
                message: "Configure an AI provider now?",
                default: true,
            });
            if (configureAI) {
                const { configCommand } = await import("./commands/config");
                await configCommand(undefined, { projectPath });
            }
        }

        console.log(chalk.green("\n✓ Project initialization complete!"));
        console.log(chalk.cyan("\nNext steps:"));
        console.log(
            chalk.gray('  1. Run "raiken test" — the example spec passes with no app needed'),
        );
        console.log(chalk.gray('  2. Run "raiken" to start the interactive agent'));
        console.log(chalk.gray('  3. Use "/config" anytime to update this project\'s AI setup'));
        console.log(
            chalk.gray('  4. Or open "raiken start" — the dashboard uses the same AI setting\n'),
        );

        if (preferences.testFramework === "playwright" && !webServerConfigured) {
            console.log(chalk.yellow("⚠ No dev/start/serve script found in package.json."));
            console.log(
                chalk.gray(
                    "   Tests against your app need it running first — start it yourself, or add a\n" +
                        "   dev script and reinstate the webServer block noted in playwright.config.ts.\n",
                ),
            );
        }

        // Additional info based on choices
        if (
            (!preferences.installPlaywright || skipBrowsers) &&
            preferences.testFramework === "playwright"
        ) {
            console.log(chalk.yellow("⚠ Remember to install Playwright browsers:"));
            console.log(chalk.gray("   npx playwright install chromium\n"));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.log(chalk.red(`\n✗ Setup failed: ${message}`));
        console.log(chalk.yellow('\nTip: You can safely re-run "raiken init" to try again.'));
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
        case "playwright":
            return "example.spec.ts";
        case "cypress":
            return "example.cy.ts";
        case "vitest":
        case "jest":
            return "example.test.ts";
        default:
            return "example.test.js";
    }
}

async function initializeRaikenDirectory(projectPath: string): Promise<void> {
    const raikenDirPath = path.join(projectPath, ".raiken");

    await fs.mkdir(raikenDirPath, { recursive: true });
    console.log(chalk.green("✓ Created .raiken/ directory"));

    // Create a README to explain the directory
    const readmePath = path.join(raikenDirPath, "README.md");
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
    await fs.mkdir(path.join(raikenDirPath, "cache"), { recursive: true });
}

async function updateGitignore(projectPath: string): Promise<void> {
    const gitignorePath = path.join(projectPath, ".gitignore");

    let gitignoreContent = "";

    try {
        gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
    } catch {
        // .gitignore doesn't exist, will create it
    }

    const hasRaiken = gitignoreContent.includes(".raiken/");
    const hasRaikenConfig = gitignoreContent.includes("raiken.config.json");
    const hasCrawleeStorage = gitignoreContent.includes("storage/");

    if (!hasRaiken || !hasRaikenConfig || !hasCrawleeStorage) {
        let raikenSection = "";
        if (!hasRaiken || !hasRaikenConfig) {
            raikenSection += "\n# Raiken local state and credentials\n";
            if (!hasRaiken) raikenSection += ".raiken/\n";
            if (!hasRaikenConfig) raikenSection += "raiken.config.json\n";
        }
        if (!hasCrawleeStorage) {
            raikenSection += "# Crawlee storage (site discovery)\nstorage/\n";
        }
        if (!hasRaiken || !hasRaikenConfig) {
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
    const testResultsPath = path.join(projectPath, "test-results");
    const testReportsPath = path.join(projectPath, "test-reports");

    // Create test-results directory (for Playwright artifacts)
    await fs.mkdir(testResultsPath, { recursive: true });

    // Create test-reports directory (for Raiken reports - separate from Playwright)
    await fs.mkdir(testReportsPath, { recursive: true });

    // Create .gitignore in test-results to exclude Playwright artifacts
    const testResultsGitignorePath = path.join(testResultsPath, ".gitignore");
    const testResultsGitignoreContent = `# Playwright test artifacts
*
!.gitignore
`;

    const testResultsGitignoreExists = await checkFileExists(testResultsGitignorePath);
    if (!testResultsGitignoreExists) {
        await fs.writeFile(testResultsGitignorePath, testResultsGitignoreContent);
        console.log(chalk.green("✓ Created test-results/.gitignore"));
    }

    // Create .gitignore in test-reports to exclude report JSON files
    const testReportsGitignorePath = path.join(testReportsPath, ".gitignore");
    const testReportsGitignoreContent = `# Test report JSON files
*.json
`;

    const testReportsGitignoreExists = await checkFileExists(testReportsGitignorePath);
    if (!testReportsGitignoreExists) {
        await fs.writeFile(testReportsGitignorePath, testReportsGitignoreContent);
        console.log(chalk.green("✓ Created test-reports/.gitignore"));
    }

    console.log(chalk.green("✓ Created test-results/ and test-reports/ directories"));
}

async function createRaikenConfig(
    projectPath: string,
    projectInfo: ProjectInfo,
    force: boolean,
): Promise<void> {
    const configPath = path.join(projectPath, "raiken.config.json");

    // `createConfig` defaults `ai.provider` to "openrouter" unconditionally.
    // If the user only has a *different* provider's key in their
    // environment (e.g. ANTHROPIC_API_KEY, no OPENROUTER_API_KEY), writing
    // that default means `resolveAIConfig` checks the wrong env var forever
    // and every status check reports "missing key" despite a working key
    // sitting right there. Detect it up front and bake the matching
    // provider (+ its default model/baseURL) into the generated config so
    // it "just works" the moment `init` finishes.
    const detected = detectAIProviderFromEnv();
    const provider = detected ? listProviders().find((p) => p.id === detected.provider) : null;

    const config = createConfig({
        projectType: projectInfo.type,
        testDirectory: projectInfo.testDir,
        ...(provider
            ? {
                  ai: {
                      provider: provider.id,
                      model: provider.defaultModel,
                      baseURL: provider.defaultBaseURL || undefined,
                  },
              }
            : {}),
    });

    try {
        await fs.access(configPath);
        if (!force) {
            console.log(
                chalk.yellow("⚠ raiken.config.json already exists (use --force to overwrite)"),
            );
            return;
        }
    } catch {
        // File doesn't exist, proceed
    }

    await writeConfigAtomic(projectPath, config);
    console.log(chalk.green("✓ Created raiken.config.json"));

    if (detected && provider) {
        console.log(
            chalk.green(`✓ Found ${detected.envVar} — defaulting to ${provider.label}`) +
                chalk.gray(" (change anytime with `raiken config` or in Settings)"),
        );
    } else {
        console.log(
            chalk.yellow("⚠ No AI provider key found in your environment.") +
                chalk.gray(
                    "\n   Run `raiken config` to select a provider and store a local key, or set the " +
                        "provider's environment variable before generating tests.",
                ),
        );
    }
}

async function setupPlaywrightConfig(
    projectPath: string,
    projectInfo: ProjectInfo,
    force: boolean,
): Promise<boolean> {
    const configPath = path.join(projectPath, "playwright.config.ts");

    // Prefer a port discovered from the project's actual config files
    // (vite.config.ts → server.port, angular.json → architect.serve.options.port,
    // package.json scripts → --port flag). Only fall back to the static
    // framework default if nothing is configured. `webServer.port` always
    // uses this — it's what Playwright polls to know the *local* dev
    // server is ready, so it has to stay a real local port regardless of
    // what `use.baseURL` displays.
    const detectedPort =
        projectInfo.devServerPort ??
        (await detectDevServerPort(projectPath, getDefaultPort(projectInfo.type)));

    // If we're about to overwrite an existing config (--force), keep its
    // baseURL rather than clobbering a deliberately-set value (e.g. a
    // staging URL) with the freshly auto-detected dev-server port. Only
    // relevant on the overwrite path — when the config doesn't exist yet
    // there's nothing to preserve.
    const baseURL =
        projectInfo.existingPlaywrightConfig?.baseURL ?? `http://localhost:${detectedPort}`;

    const devCommand = getDevCommand(projectInfo);

    // Only wire `webServer` when a real script exists to start the app. A
    // scaffold that references a non-existent script makes every test run
    // fail before a single spec executes; omitting the block lets Playwright
    // run against whatever the user starts themselves (or the self-contained
    // example spec, which needs no server at all).
    const webServerBlock = devCommand
        ? `  webServer: {
    command: '${devCommand}',
    port: ${detectedPort},
    reuseExistingServer: !process.env.CI,
  },
`
        : `  // No dev/start/serve script was found in package.json, so no webServer
  // block was generated. Start your app yourself before running tests against
  // it — or add a dev script and reinstate:
  // webServer: { command: 'npm run dev', port: ${detectedPort}, reuseExistingServer: !process.env.CI },
`;

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
    baseURL: '${baseURL}',
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
${webServerBlock}});
`;

    try {
        await fs.access(configPath);
        if (!force) {
            console.log(
                chalk.yellow("⚠ playwright.config.ts already exists (use --force to overwrite)"),
            );
            return devCommand !== null;
        }
    } catch {
        // File doesn't exist, proceed
    }

    await fs.writeFile(configPath, config);
    console.log(chalk.green("✓ Created playwright.config.ts"));
    return devCommand !== null;
}

async function updatePackageScripts(
    projectPath: string,
    _projectInfo: ProjectInfo,
    testFramework: TestFramework,
): Promise<void> {
    const packageJsonPath = path.join(projectPath, "package.json");

    const packageContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageContent);

    // Base Raiken script
    const newScripts: Record<string, string> = {
        raiken: "raiken start",
    };

    // Add framework-specific scripts
    switch (testFramework) {
        case "playwright":
            newScripts["test:e2e"] = "playwright test";
            newScripts["test:e2e:ui"] = "playwright test --ui";
            newScripts["test:e2e:debug"] = "playwright test --debug";
            newScripts["test:e2e:headed"] = "playwright test --headed";
            break;

        case "cypress":
            newScripts["test:e2e"] = "cypress run";
            newScripts["test:e2e:open"] = "cypress open";
            break;

        case "vitest":
            newScripts["test:e2e"] = "vitest run";
            newScripts["test:e2e:watch"] = "vitest watch";
            break;

        case "jest":
            newScripts["test:e2e"] = "jest";
            newScripts["test:e2e:watch"] = "jest --watch";
            break;

        case "none":
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
    console.log(chalk.green("✓ Updated package.json scripts"));
}

async function createExampleTest(projectPath: string, projectInfo: ProjectInfo): Promise<void> {
    const fileName = getExampleTestFilename(projectInfo.testFramework);
    const testPath = path.join(projectPath, projectInfo.testDir, fileName);

    // Check if file already exists
    if (await checkFileExists(testPath)) {
        console.log(
            chalk.gray(`  Example test already exists: ${projectInfo.testDir}/${fileName}`),
        );
        return;
    }

    let exampleTest = "";

    switch (projectInfo.testFramework) {
        case "playwright":
            // The first test is deliberately self-contained: it proves the
            // Playwright toolchain works (package installed, browsers
            // downloaded, config loads) without needing the app to be
            // running. A title-asserts-project-name test against `/` fails
            // out of the box for almost every scaffold and teaches new users
            // that raiken tests are flaky — the opposite of its purpose.
            exampleTest = `import { test, expect } from '@playwright/test';

test('playwright setup works', async ({ page }) => {
  // Self-contained smoke test — no app server required.
  await page.setContent('<h1>Hello from Raiken</h1>');
  await expect(page.locator('h1')).toHaveText('Hello from Raiken');
});

// Ready for your real app? Add another spec in this directory and:
//   1. Navigate with page.goto('/') — Playwright starts your app automatically
//      when playwright.config.ts has a webServer block.
//   2. Assert with expect(page.getByRole('heading')).toBeVisible(), click with
//      page.click('button[data-testid="my-button"]'), and so on.
// (raiken doctor flags commented-out page.goto lines as debug leftovers, so
// this template is prose on purpose.)
`;
            break;

        case "cypress":
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

        case "vitest":
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

        case "jest":
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
            console.log(chalk.gray("  Skipping example test generation"));
            return;
    }

    await fs.writeFile(testPath, exampleTest);
    console.log(chalk.green(`✓ Created example test: ${projectInfo.testDir}/${fileName}`));
}

function getDefaultPort(projectType: string): number {
    switch (projectType) {
        case "nextjs":
        case "react":
        case "nuxt":
            return 3000;
        case "svelte":
        case "vite":
            return 5173;
        case "angular":
            return 4200;
        default:
            return 3000;
    }
}

/**
 * The dev-server command for Playwright's `webServer` block, or null when the
 * project has no script that could start one. Previously this fell back to
 * `npm run dev` unconditionally — for a project without a `dev` script the
 * generated config then pointed Playwright at a command that cannot exist, so
 * the very first `raiken test` died with "Missing script: dev" before running
 * a single test.
 */
function getDevCommand(projectInfo: ProjectInfo): string | null {
    // Determine the package manager command
    const runCommand =
        projectInfo.packageManager === "npm" ? "npm run" : projectInfo.packageManager;

    // Find the appropriate dev script
    if (projectInfo.scripts.dev) return `${runCommand} dev`;
    if (projectInfo.scripts.start) return `${runCommand} start`;
    if (projectInfo.scripts.serve) return `${runCommand} serve`;

    return null;
}

/**
 * Package-manager install command for `@playwright/test` as a dev
 * dependency, per manager. `npm`/`yarn`/`pnpm`/`bun` all support `-D`.
 */
export function getPlaywrightInstallCommand(manager: PackageManager): {
    cmd: string;
    args: string[];
} {
    switch (manager) {
        case "yarn":
            return { cmd: "yarn", args: ["add", "-D", "@playwright/test"] };
        case "pnpm":
            return { cmd: "pnpm", args: ["add", "-D", "@playwright/test"] };
        case "bun":
            return { cmd: "bun", args: ["add", "-d", "@playwright/test"] };
        default:
            return { cmd: "npm", args: ["install", "-D", "@playwright/test"] };
    }
}

/**
 * Install `@playwright/test` itself (not the browser binaries — see
 * `installPlaywrightBrowsers`). Returns whether the package is usable
 * afterward, so the caller can decide whether it's safe to proceed with
 * browser installation and example-test generation.
 */
async function installPlaywrightPackage(
    projectPath: string,
    projectInfo: ProjectInfo,
): Promise<boolean> {
    const { cmd, args } = getPlaywrightInstallCommand(projectInfo.packageManager);
    console.log(chalk.blue(`Installing @playwright/test (${cmd} ${args.join(" ")})...`));

    // The timeout handle must be cleared once the race settles — an uncleared
    // 120s timer keeps the Node event loop (and so the whole `raiken init`
    // process) alive for two minutes after the completion message.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
        await Promise.race([
            new Promise<void>((resolve, reject) => {
                child = spawn(cmd, args, { cwd: projectPath, stdio: "inherit" });
                child.on("close", (code: number) => {
                    if (code === 0) {
                        console.log(chalk.green("✓ Installed @playwright/test"));
                        resolve();
                    } else {
                        reject(new Error(`${cmd} exited with code ${code}`));
                    }
                });
                child.on("error", (error: Error) => {
                    reject(new Error(`Failed to start ${cmd}: ${error.message}`));
                });
            }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    if (child && !child.killed) child.kill("SIGTERM");
                    reject(new Error("@playwright/test install timed out"));
                }, 120000);
            }),
        ]);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.log(chalk.yellow(`⚠ Could not install @playwright/test automatically: ${message}`));
        console.log(
            chalk.gray(`   Install it manually: ${cmd} ${args.join(" ")}\n`) +
                chalk.gray("   Tests won't run until it's installed."),
        );
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function installPlaywrightBrowsers(
    projectPath: string,
    playwrightPackageReady: boolean,
): Promise<void> {
    // Browser binaries are useless without the test runner package itself
    // — and `npx playwright install` on a project with no Playwright
    // dependency at all tends to just fetch/run the global CLI, which is
    // more confusing than helpful here.
    if (!playwrightPackageReady) {
        console.log(
            chalk.yellow("⚠ @playwright/test isn't installed — skipping browser installation"),
        );
        return;
    }

    // The generated playwright.config.ts only enables the chromium project,
    // so only install chromium — a bare `playwright install` downloads every
    // browser (~450 MB) for engines the config never uses. Users who
    // uncomment firefox/webkit can install those explicitly later.
    console.log(chalk.blue("Installing Playwright chromium browser..."));

    // Same un-cleared-timer pitfall as installPlaywrightPackage — without
    // clearTimeout, the process lingers for the full two minutes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
        // Use Promise.race to implement timeout
        await Promise.race([
            new Promise<void>((resolve, reject) => {
                child = spawn("npx", ["playwright", "install", "chromium"], {
                    cwd: projectPath,
                    stdio: "inherit", // Show output to user
                });

                child.on("close", (code: number) => {
                    if (code === 0) {
                        console.log(chalk.green("✓ Playwright chromium installed successfully"));
                        resolve();
                    } else {
                        console.log(
                            chalk.yellow(`⚠ Playwright install failed (exit code ${code})`),
                        );
                        reject(new Error(`Playwright install exited with code ${code}`));
                    }
                });

                child.on("error", (error: Error) => {
                    console.log(chalk.yellow("⚠ Failed to start Playwright installation"));
                    reject(new Error(`Failed to start Playwright install: ${error.message}`));
                });
            }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    if (child && !child.killed) child.kill("SIGTERM");
                    console.log(chalk.yellow("⚠ Playwright browser installation timed out"));
                    reject(new Error("Playwright browser installation timed out after 2 minutes"));
                }, 120000);
            }),
        ]);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.log(chalk.yellow(`⚠ Playwright browser installation failed: ${message}`));
        console.log(
            chalk.gray("  You can install them manually with: npx playwright install chromium"),
        );
        // Don't re-throw - this is not critical for setup completion
    } finally {
        if (timer) clearTimeout(timer);
    }
}
