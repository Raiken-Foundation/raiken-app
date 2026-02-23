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
    discovery?: {
        maxPages?: number;
        maxDepth?: number;
        maxConcurrency?: number;
        timeout?: number;
        excludePatterns?: string[];
        pauseOnAuth?: boolean;
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
    discovery: {
        maxPages: 100,
        maxDepth: 5,
        maxConcurrency: 3,
        timeout: 30000,
        excludePatterns: [],
        pauseOnAuth: true
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
        indexing: { fullScan: overrides.indexing?.fullScan ?? defaultConfig.indexing!.fullScan },
        discovery: { ...defaultConfig.discovery, ...(overrides.discovery || {}) }
    };
}

/** Fully-resolved discovery config with no optional fields. */
export interface ResolvedDiscoveryConfig {
    maxPages: number;
    maxDepth: number;
    maxConcurrency: number;
    timeout: number;
    excludePatterns: string[];
    pauseOnAuth: boolean;
}

const DISCOVERY_DEFAULTS: ResolvedDiscoveryConfig = defaultConfig.discovery as ResolvedDiscoveryConfig;

/**
 * Read and validate discovery config from raiken.config.json.
 * Falls back to defaults for any missing or invalid values.
 */
export function loadDiscoveryConfig(projectPath: string): ResolvedDiscoveryConfig {
    // Dynamic import of fs + path to avoid bundling issues in browser contexts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");

    const configPath = pathMod.join(projectPath, "raiken.config.json");

    try {
        const raw = fsSync.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as { discovery?: Partial<ResolvedDiscoveryConfig> };
        const d = parsed.discovery ?? {};

        return {
            maxPages:
                typeof d.maxPages === "number" && d.maxPages > 0
                    ? d.maxPages
                    : DISCOVERY_DEFAULTS.maxPages,
            maxDepth:
                typeof d.maxDepth === "number" && d.maxDepth > 0
                    ? d.maxDepth
                    : DISCOVERY_DEFAULTS.maxDepth,
            maxConcurrency:
                typeof d.maxConcurrency === "number" && d.maxConcurrency > 0
                    ? d.maxConcurrency
                    : DISCOVERY_DEFAULTS.maxConcurrency,
            timeout:
                typeof d.timeout === "number" && d.timeout > 0
                    ? d.timeout
                    : DISCOVERY_DEFAULTS.timeout,
            excludePatterns: Array.isArray(d.excludePatterns)
                ? d.excludePatterns
                : DISCOVERY_DEFAULTS.excludePatterns,
            pauseOnAuth:
                typeof d.pauseOnAuth === "boolean"
                    ? d.pauseOnAuth
                    : DISCOVERY_DEFAULTS.pauseOnAuth,
        };
    } catch {
        return { ...DISCOVERY_DEFAULTS };
    }
}
