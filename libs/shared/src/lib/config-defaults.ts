import type { RaikenConfig } from "./config-public";

/**
 * Dashboard settings placeholders. Values are kept aligned with core
 * `defaultConfig` via `config-parity.server.spec.ts` (runtime) and compile-time
 * parity aliases in `config-parity.server.ts`.
 */
export const defaultConfig: RaikenConfig = {
    projectType: "generic",
    testDirectory: "e2e",
    playwrightConfig: "playwright.config.ts",
    outputFormats: ["typescript"],
    ai: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        baseURL: "https://openrouter.ai/api/v1",
        maxTokens: 4000,
        temperature: 0.7,
    },
    auth: {},
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
        excludePatterns: [],
        pauseOnAuth: true,
        maxRunTimeMs: 30 * 60 * 1000,
        preserveQueryParams: false,
    },
    indexing: { fullScan: false },
    integrations: {
        provider: "github",
    },
};
