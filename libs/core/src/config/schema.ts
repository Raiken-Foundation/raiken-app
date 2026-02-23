/**
 * Configuration Schema for raiken.config.json
 *
 * Defines the structure and validation for Raiken project configuration.
 */

import { z } from "zod";

/**
 * AI Configuration Schema
 */
export const aiConfigSchema = z.object({
    /** OpenRouter API key (can also be set via OPENROUTER_API_KEY env var) */
    apiKey: z.string().optional(),
    /** AI model to use (default: anthropic/claude-sonnet-4.5) */
    model: z.string().optional(),
    /** OpenRouter base URL (default: https://openrouter.ai/api/v1) */
    baseURL: z.string().url().optional(),
    /** Maximum tokens per request (default: 4000) */
    maxTokens: z.number().int().positive().optional(),
    /** Temperature for AI responses (default: 0.7) */
    temperature: z.number().min(0).max(2).optional(),
});

/**
 * Autonomy Configuration Schema
 */
export const autonomyConfigSchema = z.object({
    /** Automatically save generated tests without confirmation (default: false) */
    autoSaveTests: z.boolean().optional(),
    /** Automatically run tests after generation (default: false) */
    autoRunTests: z.boolean().optional(),
    /** Auto-correct failing tests: 'suggest' | 'auto' | 'off' (default: 'suggest') */
    autoCorrect: z.enum(["suggest", "auto", "off"]).optional(),
    /** Learn from test outcomes: 'confirm' | 'auto' | 'off' (default: 'confirm') */
    autoLearn: z.enum(["confirm", "auto", "off"]).optional(),
});

/**
 * Site Discovery Configuration Schema
 */
export const discoveryConfigSchema = z.object({
    /** Maximum number of pages to discover (default: 100) */
    maxPages: z.number().int().positive().optional(),
    /** Maximum navigation depth from start URL (default: 5) */
    maxDepth: z.number().int().positive().optional(),
    /** Maximum concurrent browser instances (default: 3) */
    maxConcurrency: z.number().int().positive().optional(),
    /** Timeout per page in milliseconds (default: 30000) */
    timeout: z.number().int().positive().optional(),
    /** URL patterns to exclude from discovery (e.g., ['/logout', '/api/']) */
    excludePatterns: z.array(z.string()).optional(),
    /** Pause discovery when authentication is detected (default: true) */
    pauseOnAuth: z.boolean().optional(),
});

/**
 * Complete Raiken Configuration Schema
 */
export const raikenConfigSchema = z.object({
    /** Test directory relative to project root (default: 'e2e') */
    testDirectory: z.string().optional(),
    /** AI configuration */
    ai: aiConfigSchema.optional(),
    /** Autonomy settings */
    autonomy: autonomyConfigSchema.optional(),
    /** Site discovery settings */
    discovery: discoveryConfigSchema.optional(),
});

/**
 * TypeScript types inferred from schemas
 */
export type AIConfig = z.infer<typeof aiConfigSchema>;
export type AutonomyConfig = z.infer<typeof autonomyConfigSchema>;
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;
export type RaikenConfig = z.infer<typeof raikenConfigSchema>;

/**
 * Default configuration values
 */
export const defaultConfig: Required<RaikenConfig> = {
    testDirectory: "e2e",
    ai: {
        model: "anthropic/claude-sonnet-4.5",
        baseURL: "https://openrouter.ai/api/v1",
        maxTokens: 4000,
        temperature: 0.7,
    },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
    },
    discovery: {
        maxPages: 100,
        maxDepth: 5,
        maxConcurrency: 3,
        timeout: 30000,
        excludePatterns: [],
        pauseOnAuth: true,
    },
};

/**
 * Load and validate configuration from a JSON object
 */
export function validateConfig(config: unknown): RaikenConfig {
    return raikenConfigSchema.parse(config);
}

/**
 * Merge user config with defaults
 */
export function mergeConfig(
    userConfig: Partial<RaikenConfig>
): Required<RaikenConfig> {
    return {
        testDirectory: userConfig.testDirectory ?? defaultConfig.testDirectory,
        ai: {
            ...defaultConfig.ai,
            ...userConfig.ai,
        },
        autonomy: {
            ...defaultConfig.autonomy,
            ...userConfig.autonomy,
        },
        discovery: {
            ...defaultConfig.discovery,
            ...userConfig.discovery,
        },
    };
}

/**
 * Example raiken.config.json structure
 */
export const configExample: RaikenConfig = {
    testDirectory: "e2e",
    ai: {
        model: "anthropic/claude-sonnet-4.5",
        maxTokens: 4000,
        temperature: 0.7,
    },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
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
