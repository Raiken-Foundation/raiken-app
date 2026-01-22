
export interface RaikenConfig {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    storageStatePath?: string; // Path to Playwright storageState for authenticated sessions
    ai: {
        provider: 'openrouter' | 'openai';
        model: string;
        apiKey?: string;
    };
    features: {
        video: boolean;
        screenshots: boolean;
        tracing: boolean;
        network: boolean;
    };
    browser: {
        defaultBrowser: 'chromium' | 'firefox' | 'webkit';
        headless: boolean;
        timeout: number;
        retries: number;
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
    browser: {
        defaultBrowser: 'chromium',
        headless: true,
        timeout: 30000,
        retries: 1
    }
};

export function createConfig(overrides: Partial<RaikenConfig> = {}): RaikenConfig {
    return {
        ...defaultConfig,
        ...overrides,
        ai: { ...defaultConfig.ai, ...overrides.ai },
        features: { ...defaultConfig.features, ...overrides.features },
        browser: { ...defaultConfig.browser, ...overrides.browser }
    };
}
