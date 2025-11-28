export interface RaikenConfig {
    baseUrl?: string;
    projectRoot?: string;
    headless?: boolean;
}

/**
 * Define your Raiken configuration.
 */
export function defineConfig(config: RaikenConfig): RaikenConfig {
    return config;
}
