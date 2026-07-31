/**
 * Browser-safe public configuration types for dashboard clients.
 *
 * These mirror {@link PublicRaikenConfig} in `@raiken/core` but live in shared
 * so the dashboard bundle never imports core runtime modules.
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

export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export type PublicAIConfig = {
    provider?: AIProviderId;
    model?: string;
    baseURL?: string;
    maxTokens?: number;
    temperature?: number;
    apiKeyPresent?: boolean;
    apiKeysPresent?: Partial<Record<AIProviderId, boolean>>;
};

export type PublicAuthConfig = {
    storageStatePath?: string;
    baseUrl?: string;
    loginPath?: string;
    customLoginScript?: string;
    credentials?: {
        usernameEnv?: string;
        passwordEnv?: string;
        usernamePresent?: boolean;
        passwordPresent?: boolean;
    };
};

export type PublicIntegrationsConfig = {
    provider?: "github" | "jira" | "linear";
    github?: { owner?: string; repo?: string; tokenPresent?: boolean };
    jira?: {
        host?: string;
        email?: string;
        projectKey?: string;
        apiTokenPresent?: boolean;
    };
    linear?: { teamKey?: string; apiKeyPresent?: boolean };
    branchPatterns?: string[];
};

/** Redacted configuration returned by `getConfig` over tRPC. */
export type PublicRaikenConfig = {
    projectType?: string;
    testDirectory?: string;
    playwrightConfig?: string;
    outputFormats?: string[];
    ai?: PublicAIConfig;
    auth?: PublicAuthConfig;
    browser?: {
        defaultBrowser?: "chromium" | "firefox" | "webkit";
        headless?: boolean;
        timeout?: number;
        retries?: number;
    };
    features?: {
        video?: boolean;
        screenshots?: boolean;
        tracing?: boolean;
        network?: boolean;
    };
    autonomy?: {
        autoSaveTests?: boolean;
        autoRunTests?: boolean;
        autoCorrect?: "suggest" | "apply" | "off";
        autoLearn?: "confirm" | "auto" | "off";
        maxRetries?: number;
    };
    discovery?: {
        maxPages?: number;
        maxDepth?: number;
        maxConcurrency?: number;
        timeout?: number;
        excludePatterns?: string[];
        pauseOnAuth?: boolean;
        maxRunTimeMs?: number;
        preserveQueryParams?: boolean;
    };
    indexing?: { fullScan?: boolean };
    integrations?: PublicIntegrationsConfig;
};

/** Settings-form defaults shown as placeholders in the dashboard UI. */
export type RaikenConfig = {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    ai: {
        provider: AIProviderId | string;
        model: string;
        baseURL?: string;
        maxTokens?: number;
        temperature?: number;
    };
    auth: Record<string, never>;
    browser: {
        defaultBrowser: string;
        headless: boolean;
        timeout: number;
        retries: number;
    };
    features: {
        video: boolean;
        screenshots: boolean;
        tracing: boolean;
        network: boolean;
    };
    autonomy: {
        autoSaveTests: boolean;
        autoRunTests: boolean;
        autoCorrect: "suggest" | "apply" | "off";
        autoLearn: "confirm" | "auto" | "off";
        maxRetries: number;
    };
    discovery: {
        maxPages: number;
        maxDepth: number;
        maxConcurrency: number;
        timeout: number;
        excludePatterns: string[];
        pauseOnAuth: boolean;
        maxRunTimeMs: number;
        preserveQueryParams: boolean;
    };
    indexing: { fullScan: boolean };
    integrations: {
        provider: string;
        branchPatterns?: string[];
    };
};
