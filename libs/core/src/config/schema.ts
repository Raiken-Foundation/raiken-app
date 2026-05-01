/**
 * Configuration Schema for raiken.config.json
 *
 * Single source of truth for all Raiken configuration.
 */

import { z } from "zod";

/**
 * Supported AI providers. Most expose an OpenAI-compatible /v1/models endpoint
 * so models can be discovered dynamically by hitting the provider's API.
 */
export const AI_PROVIDER_IDS = [
    "openrouter",
    "openai",
    "anthropic",
    "google",
    "groq",
    "mistral",
    "deepseek",
    "xai",
    "together",
    "perplexity",
    "ollama",
    "custom",
] as const;

export const aiProviderSchema = z.enum(AI_PROVIDER_IDS);
export type AIProviderId = z.infer<typeof aiProviderSchema>;

export const aiConfigSchema = z.object({
    /** AI provider (default: 'openrouter'). One of {@link AI_PROVIDER_IDS}. */
    provider: aiProviderSchema.optional(),
    /** Provider API key (also resolvable from a provider-specific env var; see PROVIDER_ENV_VARS). */
    apiKey: z.string().optional(),
    /** AI model identifier (e.g. anthropic/claude-sonnet-4.5, gpt-4o, claude-3-5-sonnet-20241022). */
    model: z.string().optional(),
    /** Base URL override (used for self-hosted Ollama or 'custom' providers). */
    baseURL: z.string().url().optional(),
    /** Maximum tokens per request (default: 4000) */
    maxTokens: z.number().int().positive().optional(),
    /** Temperature for AI responses (default: 0.7) */
    temperature: z.number().min(0).max(2).optional(),
});

export const authConfigSchema = z.object({
    /** Path to Playwright storageState for authenticated sessions */
    storageStatePath: z.string().optional(),
    /** Base URL for the application (used for auth flows) */
    baseUrl: z.string().optional(),
    /** Login page path (relative to baseUrl) */
    loginPath: z.string().optional(),
    /** Test credentials (use environment variables in production) */
    credentials: z
        .object({
            username: z.string().optional(),
            password: z.string().optional(),
            usernameEnv: z.string().optional(),
            passwordEnv: z.string().optional(),
        })
        .optional(),
    /** Custom login steps (for complex auth flows) */
    customLoginScript: z.string().optional(),
});

export const browserConfigSchema = z.object({
    /** Default browser engine (default: 'chromium') */
    defaultBrowser: z.enum(["chromium", "firefox", "webkit"]).optional(),
    /** Run in headless mode (default: true) */
    headless: z.boolean().optional(),
    /** Default timeout in ms (default: 30000) */
    timeout: z.number().int().positive().optional(),
    /** Number of retries on failure (default: 1) */
    retries: z.number().int().min(0).optional(),
});

export const featuresConfigSchema = z.object({
    /** Record video of test runs (default: true) */
    video: z.boolean().optional(),
    /** Capture screenshots on failure (default: true) */
    screenshots: z.boolean().optional(),
    /** Enable Playwright tracing (default: false) */
    tracing: z.boolean().optional(),
    /** Capture network requests (default: true) */
    network: z.boolean().optional(),
});

export const autonomyConfigSchema = z.object({
    /** Automatically save generated tests without confirmation (default: false) */
    autoSaveTests: z.boolean().optional(),
    /** Automatically run tests after generation (default: false) */
    autoRunTests: z.boolean().optional(),
    /** Auto-correct failing tests: 'suggest' shows diff, 'apply' auto-applies, 'off' disables (default: 'suggest') */
    autoCorrect: z.enum(["suggest", "apply", "off"]).optional(),
    /** Learn from test outcomes: 'confirm' | 'auto' | 'off' (default: 'confirm') */
    autoLearn: z.enum(["confirm", "auto", "off"]).optional(),
    /** Maximum auto-retries on test failure (default: 2) */
    maxRetries: z.number().int().min(0).optional(),
});

export const discoveryConfigSchema = z.object({
    /** Maximum number of pages to discover (default: 100) */
    maxPages: z.number().int().positive().optional(),
    /** Maximum navigation depth from start URL (default: 5) */
    maxDepth: z.number().int().positive().optional(),
    /** Maximum concurrent browser instances (default: 3) */
    maxConcurrency: z.number().int().positive().optional(),
    /** Per-page navigation timeout in milliseconds (default: 30000) */
    timeout: z.number().int().positive().optional(),
    /** URL patterns to exclude from discovery. Supports substring (legacy) or globs (`*`, `**`) when the pattern contains `*`. */
    excludePatterns: z.array(z.string()).optional(),
    /** Pause discovery when authentication is detected (default: true) */
    pauseOnAuth: z.boolean().optional(),
    /** Hard wall-clock cap on a single discovery run, in ms (default: 1_800_000 = 30 min). 0 disables. */
    maxRunTimeMs: z.number().int().min(0).optional(),
});

export const indexingConfigSchema = z.object({
    /** Force full project scan for AST/DB indexing (default: false) */
    fullScan: z.boolean().optional(),
});

export const integrationsConfigSchema = z.object({
    /** Ticket provider: 'github', 'jira', or 'linear' (default: 'github') */
    provider: z.enum(["github", "jira", "linear"]).optional(),
    /** GitHub-specific settings */
    github: z
        .object({
            /** PAT (prefer GITHUB_TOKEN env var instead of committing this) */
            token: z.string().optional(),
            /** Repository owner (auto-detected from git remote if omitted) */
            owner: z.string().optional(),
            /** Repository name (auto-detected from git remote if omitted) */
            repo: z.string().optional(),
        })
        .optional(),
    /** Jira-specific settings (not yet implemented) */
    jira: z
        .object({
            host: z.string().optional(),
            email: z.string().optional(),
            apiToken: z.string().optional(),
            projectKey: z.string().optional(),
        })
        .optional(),
    /** Linear-specific settings (not yet implemented) */
    linear: z
        .object({
            apiKey: z.string().optional(),
            teamKey: z.string().optional(),
        })
        .optional(),
    /** Custom regex patterns for extracting ticket IDs from branch names */
    branchPatterns: z.array(z.string()).optional(),
});

export const raikenConfigSchema = z.object({
    /** Project type identifier (default: 'generic') */
    projectType: z.string().optional(),
    /** Test directory relative to project root (default: 'e2e') */
    testDirectory: z.string().optional(),
    /** Path to Playwright config file (default: 'playwright.config.ts') */
    playwrightConfig: z.string().optional(),
    /** Output formats for generated tests (default: ['typescript']) */
    outputFormats: z.array(z.string()).optional(),
    /** AI configuration */
    ai: aiConfigSchema.optional(),
    /** Authentication settings */
    auth: authConfigSchema.optional(),
    /** Browser settings */
    browser: browserConfigSchema.optional(),
    /** Feature flags */
    features: featuresConfigSchema.optional(),
    /** Autonomy settings */
    autonomy: autonomyConfigSchema.optional(),
    /** Site discovery settings */
    discovery: discoveryConfigSchema.optional(),
    /** Indexing settings */
    indexing: indexingConfigSchema.optional(),
    /** Ticket system integration settings */
    integrations: integrationsConfigSchema.optional(),
});

export type AIConfig = z.infer<typeof aiConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export type FeaturesConfig = z.infer<typeof featuresConfigSchema>;
export type AutonomyConfig = z.infer<typeof autonomyConfigSchema>;
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;
export type IndexingConfig = z.infer<typeof indexingConfigSchema>;
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
export type RaikenConfig = z.infer<typeof raikenConfigSchema>;

export const defaultConfig = {
    projectType: "generic",
    testDirectory: "e2e",
    playwrightConfig: "playwright.config.ts",
    outputFormats: ["typescript"],
    ai: {
        provider: "openrouter" as const,
        model: "anthropic/claude-sonnet-4.5",
        baseURL: "https://openrouter.ai/api/v1",
        maxTokens: 4000,
        temperature: 0.7,
    },
    auth: {},
    browser: {
        defaultBrowser: "chromium" as const,
        headless: true,
        timeout: 30000,
        retries: 1,
    },
    features: {
        video: true,
        screenshots: true,
        tracing: false,
        network: true,
    },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest" as const,
        autoLearn: "confirm" as const,
        maxRetries: 2,
    },
    discovery: {
        maxPages: 100,
        maxDepth: 5,
        maxConcurrency: 3,
        timeout: 30000,
        excludePatterns: [] as string[],
        pauseOnAuth: true,
        maxRunTimeMs: 30 * 60 * 1000,
    },
    indexing: {
        fullScan: false,
    },
    integrations: {
        provider: "github" as const,
    },
} satisfies Required<RaikenConfig>;

export function validateConfig(config: unknown): RaikenConfig {
    return raikenConfigSchema.parse(config);
}

export type ResolvedRaikenConfig = {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    ai: z.infer<typeof aiConfigSchema>;
    auth: z.infer<typeof authConfigSchema>;
    browser: z.infer<typeof browserConfigSchema>;
    features: z.infer<typeof featuresConfigSchema>;
    autonomy: z.infer<typeof autonomyConfigSchema>;
    discovery: z.infer<typeof discoveryConfigSchema>;
    indexing: z.infer<typeof indexingConfigSchema>;
    integrations: z.infer<typeof integrationsConfigSchema>;
};

export function mergeConfig(userConfig: Partial<RaikenConfig>): ResolvedRaikenConfig {
    return {
        projectType: userConfig.projectType ?? defaultConfig.projectType,
        testDirectory: userConfig.testDirectory ?? defaultConfig.testDirectory,
        playwrightConfig: userConfig.playwrightConfig ?? defaultConfig.playwrightConfig,
        outputFormats: userConfig.outputFormats ?? defaultConfig.outputFormats,
        ai: { ...defaultConfig.ai, ...userConfig.ai },
        auth: { ...defaultConfig.auth, ...userConfig.auth },
        browser: { ...defaultConfig.browser, ...userConfig.browser },
        features: { ...defaultConfig.features, ...userConfig.features },
        autonomy: { ...defaultConfig.autonomy, ...userConfig.autonomy },
        discovery: { ...defaultConfig.discovery, ...userConfig.discovery },
        indexing: { ...defaultConfig.indexing, ...userConfig.indexing },
        integrations: { ...defaultConfig.integrations, ...userConfig.integrations },
    };
}

export const configExample: RaikenConfig = {
    projectType: "generic",
    testDirectory: "e2e",
    playwrightConfig: "playwright.config.ts",
    outputFormats: ["typescript"],
    ai: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        maxTokens: 4000,
        temperature: 0.7,
    },
    browser: {
        defaultBrowser: "chromium",
        headless: true,
        timeout: 30000,
        retries: 1,
    },
    features: {
        video: true,
        screenshots: true,
        tracing: false,
        network: true,
    },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
        maxRetries: 2,
    },
    discovery: {
        maxPages: 100,
        maxDepth: 5,
        maxConcurrency: 3,
        timeout: 30000,
        excludePatterns: ["/logout", "/signout", "/api/"],
        pauseOnAuth: true,
    },
};
