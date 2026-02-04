export interface RaikenConfig {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    ai: {
        provider: 'openrouter' | 'openai';
        model: string;
        apiKey?: string;
    };
    auth?: {
        /** Path to Playwright storageState for authenticated sessions */
        storageStatePath?: string;
        /** Base URL for the application (used for auth flows) */
        baseUrl?: string;
        /** Login page path (relative to baseUrl) */
        loginPath?: string;
        /** Test credentials (use environment variables in production) */
        credentials?: {
            username?: string;
            password?: string;
            /** Environment variable names to use instead of hardcoded values */
            usernameEnv?: string;
            passwordEnv?: string;
        };
        /** Custom login steps (for complex auth flows) */
        customLoginScript?: string;
    };
    features: {
        video: boolean;
        screenshots: boolean;
        tracing: boolean;
        network: boolean;
    };
    indexing?: {
        /** Force full project scan for AST/DB indexing */
        fullScan: boolean;
    };
    browser: {
        defaultBrowser: 'chromium' | 'firefox' | 'webkit';
        headless: boolean;
        timeout: number;
        retries: number;
    };
    /** Autonomy settings - control HITL checkpoints */
    autonomy?: {
        /** Auto-save tests without confirmation */
        autoSaveTests: boolean;
        /** Auto-run tests without confirmation */
        autoRunTests: boolean;
        /** Self-correction behavior: 'suggest' shows diff, 'apply' auto-applies, 'off' disables */
        autoCorrect: 'suggest' | 'apply' | 'off';
        /** Learning behavior: 'confirm' asks, 'auto' learns silently, 'off' disables */
        autoLearn: 'confirm' | 'auto' | 'off';
        /** Maximum auto-retries on test failure (0 = no retry) */
        maxRetries: number;
    };
}

export const defaultConfig: RaikenConfig = {
    projectType: 'generic',
    testDirectory: 'tests',
    playwrightConfig: 'playwright.config.ts',
    outputFormats: ['typescript'],
    ai: {
        provider: 'openrouter',
        model: 'anthropic/claude-3.5-sonnet'
    },
    features: {
        video: true,
        screenshots: true,
        tracing: false,
        network: true
    },
    indexing: {
        fullScan: false
    },
    browser: {
        defaultBrowser: 'chromium',
        headless: true,
        timeout: 30000,
        retries: 1
    },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: 'suggest',
        autoLearn: 'confirm',
        maxRetries: 2
    }
};

export function createConfig(overrides: Partial<RaikenConfig> = {}): RaikenConfig {
    return {
        ...defaultConfig,
        ...overrides,
        ai: { ...defaultConfig.ai, ...overrides.ai },
        features: { ...defaultConfig.features, ...overrides.features },
        browser: { ...defaultConfig.browser, ...overrides.browser },
        autonomy: { ...defaultConfig.autonomy!, ...(overrides.autonomy || {}) },
        indexing: { fullScan: overrides.indexing?.fullScan ?? defaultConfig.indexing!.fullScan }
    };
}
