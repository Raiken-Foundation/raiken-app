/**
 * Browser-safe configuration patch adapter for dashboard settings saves.
 *
 * Pure JSON manipulation — no filesystem, no `@raiken/core` runtime imports.
 */
import type { PublicRaikenConfig } from "./config-public";

export interface SecretDrafts {
    aiKeys: Record<string, string>;
    linearApiKey: string;
}

interface MutableAiPatch extends Record<string, unknown> {
    apiKey?: string;
    apiKeyPresent?: unknown;
    apiKeys?: Record<string, string>;
    apiKeysPresent?: unknown;
    provider?: unknown;
}

interface MutableCredentialsPatch extends Record<string, unknown> {
    passwordPresent?: unknown;
    usernamePresent?: unknown;
}

interface MutableAuthPatch extends Record<string, unknown> {
    credentials?: MutableCredentialsPatch;
}

interface MutableIntegrationPatch extends Record<string, unknown> {
    apiKeyPresent?: unknown;
    apiTokenPresent?: unknown;
    tokenPresent?: unknown;
}

interface MutableIntegrationsPatch extends Record<string, unknown> {
    github?: MutableIntegrationPatch;
    jira?: MutableIntegrationPatch;
    linear?: MutableIntegrationPatch;
}

interface MutableSettingsPatch extends Record<string, unknown> {
    ai?: MutableAiPatch;
    auth?: MutableAuthPatch;
    integrations?: MutableIntegrationsPatch;
}

/**
 * Build the write-only dashboard save payload. Public configuration data
 * never contains secret values, so only an explicitly typed draft can add a
 * credential back to this patch. Blank drafts are omitted and therefore
 * preserve saved keys.
 */
export function createSettingsConfigPatch(
    form: Partial<PublicRaikenConfig>,
    secretDrafts: SecretDrafts,
): Record<string, unknown> {
    const patch = structuredClone(form) as MutableSettingsPatch;
    const ai = patch.ai;
    if (ai && typeof ai === "object" && !Array.isArray(ai)) {
        const aiPatch = ai as MutableAiPatch;
        delete aiPatch.apiKeyPresent;
        delete aiPatch.apiKeysPresent;
        const drafts = Object.fromEntries(
            Object.entries(secretDrafts.aiKeys).filter(([, key]) => key.trim().length > 0),
        );
        if (Object.keys(drafts).length > 0) {
            aiPatch.apiKeys = drafts;
            const provider = aiPatch.provider;
            if (typeof provider === "string" && drafts[provider]) {
                aiPatch.apiKey = drafts[provider];
            }
        }
    }

    const auth = patch.auth;
    if (auth && typeof auth === "object" && !Array.isArray(auth)) {
        const credentials = auth.credentials;
        if (credentials && typeof credentials === "object" && !Array.isArray(credentials)) {
            delete credentials.usernamePresent;
            delete credentials.passwordPresent;
        }
    }

    const integrations = patch.integrations;
    if (integrations && typeof integrations === "object" && !Array.isArray(integrations)) {
        const integrationPatch = integrations as MutableIntegrationsPatch;
        if (integrationPatch.github) delete integrationPatch.github.tokenPresent;
        if (integrationPatch.jira) delete integrationPatch.jira.apiTokenPresent;
        if (integrationPatch.linear) delete integrationPatch.linear.apiKeyPresent;
        if (secretDrafts.linearApiKey.trim()) {
            const linear =
                integrationPatch.linear &&
                typeof integrationPatch.linear === "object" &&
                !Array.isArray(integrationPatch.linear)
                    ? integrationPatch.linear
                    : {};
            integrationPatch.linear = {
                ...linear,
                apiKey: secretDrafts.linearApiKey,
            };
        }
    }

    return patch;
}
