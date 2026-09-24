import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
    AI_PROVIDER_IDS,
    type AIConfig,
    type AIProviderId,
    type AuthConfig,
    type IntegrationsConfig,
    type RaikenConfig,
    raikenConfigSchema,
} from "./schema";

const CONFIG_FILE = "raiken.config.json";

const STATIC_SECRET_PATHS = [
    "ai.apiKey",
    "auth.credentials.username",
    "auth.credentials.password",
    "integrations.github.token",
    "integrations.jira.apiToken",
    "integrations.linear.apiKey",
] as const;

export type SecretConfigPath = (typeof STATIC_SECRET_PATHS)[number] | `ai.apiKeys.${AIProviderId}`;

export type PublicAIConfig = Omit<AIConfig, "apiKey" | "apiKeys"> & {
    apiKeyPresent?: boolean;
    apiKeysPresent?: Partial<Record<AIProviderId, boolean>>;
};

export type PublicAuthConfig = Omit<AuthConfig, "credentials"> & {
    credentials?: Omit<NonNullable<AuthConfig["credentials"]>, "username" | "password"> & {
        usernamePresent?: boolean;
        passwordPresent?: boolean;
    };
};

export type PublicIntegrationsConfig = Omit<IntegrationsConfig, "github" | "jira" | "linear"> & {
    github?: Omit<NonNullable<IntegrationsConfig["github"]>, "token"> & { tokenPresent?: boolean };
    jira?: Omit<NonNullable<IntegrationsConfig["jira"]>, "apiToken"> & {
        apiTokenPresent?: boolean;
    };
    linear?: Omit<NonNullable<IntegrationsConfig["linear"]>, "apiKey"> & {
        apiKeyPresent?: boolean;
    };
};

/**
 * The configuration shape exposed over the local HTTP API. Secret values are
 * deliberately absent; callers receive only `*Present` metadata.
 */
export type PublicRaikenConfig = Omit<RaikenConfig, "ai" | "auth" | "integrations"> & {
    ai?: PublicAIConfig;
    auth?: PublicAuthConfig;
    integrations?: PublicIntegrationsConfig;
};

export class PathContainmentError extends Error {
    constructor(candidate: string, projectPath: string) {
        super(`Path "${candidate}" is outside project "${projectPath}".`);
        this.name = "PathContainmentError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isLexicallyInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function nearestExistingAncestor(filePath: string): string {
    let current = filePath;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
    }
    return current;
}

/**
 * Resolve a path beneath a project after checking lexical traversal and
 * existing symlinks. The final component may not exist yet, which is required
 * for safe create operations.
 */
export function resolvePathWithinProject(projectPath: string, candidate: string): string {
    const projectRoot = fs.realpathSync(path.resolve(projectPath));
    const target = path.resolve(projectRoot, candidate);

    // Canonicalize the part of the target that exists, then re-attach the tail
    // that doesn't. Comparing a raw path against a realpath'd root produces
    // false escapes wherever the project sits behind a symlink — on macOS
    // `/tmp` and `/var` are symlinks, so an absolute path to the project's own
    // root would be rejected as being outside itself.
    const existingAncestor = nearestExistingAncestor(target);
    const realAncestor = fs.realpathSync(existingAncestor);
    const tail = path.relative(existingAncestor, target);
    const realTarget = tail ? path.join(realAncestor, tail) : realAncestor;

    if (!isLexicallyInside(projectRoot, realTarget)) {
        throw new PathContainmentError(candidate, projectRoot);
    }

    return realTarget;
}

export function getConfigPath(projectPath: string): string {
    return resolvePathWithinProject(projectPath, CONFIG_FILE);
}

export async function readRawConfig(projectPath: string): Promise<Record<string, unknown>> {
    const raw = await fsPromises.readFile(getConfigPath(projectPath), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new TypeError(`${CONFIG_FILE} must contain a JSON object.`);
    return parsed;
}

export async function readPublicConfig(projectPath: string): Promise<{
    config: PublicRaikenConfig;
    validation: { valid: boolean; issues: string[] };
}> {
    try {
        const parsed = await readRawConfig(projectPath);
        const validation = raikenConfigSchema.safeParse(parsed);
        return {
            config: redactConfig(parsed),
            validation: validation.success
                ? { valid: true, issues: [] }
                : {
                      valid: false,
                      issues: validation.error.issues.map(
                          (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
                      ),
                  },
        };
    } catch (error) {
        return {
            config: {},
            validation: {
                valid: (error as NodeJS.ErrnoException).code === "ENOENT",
                issues:
                    (error as NodeJS.ErrnoException).code === "ENOENT"
                        ? []
                        : ["Unable to read raiken.config.json."],
            },
        };
    }
}

export function readRawConfigSync(projectPath: string): Record<string, unknown> {
    const raw = fs.readFileSync(getConfigPath(projectPath), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new TypeError(`${CONFIG_FILE} must contain a JSON object.`);
    return parsed;
}

/**
 * Atomically replace this project's configuration. A sibling temporary file
 * keeps a process crash from leaving a truncated configuration behind.
 */
export async function writeConfigAtomic(
    projectPath: string,
    config: Record<string, unknown> | RaikenConfig,
): Promise<void> {
    const configPath = getConfigPath(projectPath);
    const dir = path.dirname(configPath);
    await fsPromises.mkdir(dir, { recursive: true });
    const temporaryPath = path.join(
        dir,
        `.${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
        await fsPromises.writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, "utf-8");
        await fsPromises.rename(temporaryPath, configPath);
    } catch (error) {
        await fsPromises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function writeConfigAtomicSync(
    projectPath: string,
    config: Record<string, unknown> | RaikenConfig,
): void {
    const configPath = getConfigPath(projectPath);
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const temporaryPath = path.join(
        dir,
        `.${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, "utf-8");
        fs.renameSync(temporaryPath, configPath);
    } catch (error) {
        try {
            fs.rmSync(temporaryPath, { force: true });
        } catch {
            // The original write error remains the useful one.
        }
        throw error;
    }
}

export function isSecretConfigPath(value: string): value is SecretConfigPath {
    if ((STATIC_SECRET_PATHS as readonly string[]).includes(value)) return true;
    const provider = value.slice("ai.apiKeys.".length);
    return (
        value.startsWith("ai.apiKeys.") && (AI_PROVIDER_IDS as readonly string[]).includes(provider)
    );
}

function isSecretLeaf(pathParts: string[]): boolean {
    return isSecretConfigPath(pathParts.join("."));
}

function mergeConfigValues(
    existing: Record<string, unknown>,
    patch: Record<string, unknown>,
    parentPath: string[] = [],
): Record<string, unknown> {
    const result = cloneRecord(existing);

    for (const [key, value] of Object.entries(patch)) {
        const currentPath = [...parentPath, key];
        if (isSecretLeaf(currentPath)) {
            // Secret fields are write-only: blank UI drafts mean "unchanged".
            // A caller must send an explicit clear instruction to delete one.
            if (typeof value === "string" && value.trim()) result[key] = value;
            else if (typeof value !== "string") result[key] = value;
            continue;
        }

        const previous = result[key];
        if (isRecord(previous) && isRecord(value)) {
            result[key] = mergeConfigValues(previous, value, currentPath);
        } else {
            result[key] = value;
        }
    }

    return result;
}

function deleteNestedValue(target: Record<string, unknown>, pathParts: string[]): void {
    const [head, ...tail] = pathParts;
    if (!head) return;
    if (tail.length === 0) {
        delete target[head];
        return;
    }

    const child = target[head];
    if (isRecord(child)) deleteNestedValue(child, tail);
}

function migrateLegacyKeyOnProviderSwitch(
    existing: Record<string, unknown>,
    patch: Record<string, unknown>,
    merged: Record<string, unknown>,
): void {
    const previousAi = existing["ai"];
    const patchAi = patch["ai"];
    const mergedAi = merged["ai"];
    if (!isRecord(previousAi) || !isRecord(patchAi) || !isRecord(mergedAi)) return;

    const previousProvider =
        typeof previousAi["provider"] === "string" ? previousAi["provider"] : "openrouter";
    const nextProvider = patchAi["provider"];
    const previousLegacyKey = previousAi["apiKey"];
    if (
        typeof nextProvider !== "string" ||
        nextProvider === previousProvider ||
        !isNonEmptyString(previousLegacyKey)
    ) {
        return;
    }

    const currentKeys = isRecord(mergedAi["apiKeys"]) ? mergedAi["apiKeys"] : {};
    if (!isNonEmptyString(currentKeys[previousProvider])) {
        currentKeys[previousProvider] = previousLegacyKey;
    }
    mergedAi["apiKeys"] = currentKeys;

    // The legacy key only describes the active provider. Once the active
    // provider changed, leaving it in place could route the previous
    // provider's key to the new provider. A newly supplied key remains active.
    if (!isNonEmptyString(patchAi["apiKey"])) delete mergedAi["apiKey"];
}

/**
 * Merge a public configuration patch into the trusted on-disk configuration.
 * Omitted secrets and empty secret drafts retain their existing values; only a
 * supplied non-empty secret replaces a value, and deletion is opt-in via
 * `clearSecrets`.
 */
export function applyConfigPatch(
    existing: Record<string, unknown>,
    patch: Record<string, unknown>,
    clearSecrets: readonly string[] = [],
): Record<string, unknown> {
    const merged = mergeConfigValues(existing, patch);
    migrateLegacyKeyOnProviderSwitch(existing, patch, merged);
    for (const secretPath of clearSecrets) {
        if (isSecretConfigPath(secretPath)) deleteNestedValue(merged, secretPath.split("."));
    }
    return merged;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Remove secret values from a parsed configuration before it crosses a public
 * boundary. Presence flags allow UI surfaces to accurately communicate the
 * saved state without hydrating secrets into browser memory.
 */
export function redactConfig(config: Record<string, unknown>): PublicRaikenConfig {
    const publicConfig = cloneRecord(config);
    const ai = publicConfig["ai"];
    if (isRecord(ai)) {
        const legacyKey = ai["apiKey"];
        if (isNonEmptyString(legacyKey)) ai["apiKeyPresent"] = true;
        delete ai["apiKey"];

        const apiKeys = ai["apiKeys"];
        if (isRecord(apiKeys)) {
            const presence: Record<string, boolean> = {};
            for (const [provider, key] of Object.entries(apiKeys)) {
                if (isNonEmptyString(key)) presence[provider] = true;
            }
            if (Object.keys(presence).length > 0) ai["apiKeysPresent"] = presence;
        }
        delete ai["apiKeys"];
    }

    const auth = publicConfig["auth"];
    if (isRecord(auth) && isRecord(auth["credentials"])) {
        const credentials = auth["credentials"];
        if (isNonEmptyString(credentials["username"])) credentials["usernamePresent"] = true;
        if (isNonEmptyString(credentials["password"])) credentials["passwordPresent"] = true;
        delete credentials["username"];
        delete credentials["password"];
    }

    const integrations = publicConfig["integrations"];
    if (isRecord(integrations)) {
        const github = integrations["github"];
        if (isRecord(github)) {
            if (isNonEmptyString(github["token"])) github["tokenPresent"] = true;
            delete github["token"];
        }

        const jira = integrations["jira"];
        if (isRecord(jira)) {
            if (isNonEmptyString(jira["apiToken"])) jira["apiTokenPresent"] = true;
            delete jira["apiToken"];
        }

        const linear = integrations["linear"];
        if (isRecord(linear)) {
            if (isNonEmptyString(linear["apiKey"])) linear["apiKeyPresent"] = true;
            delete linear["apiKey"];
        }
    }

    return publicConfig as PublicRaikenConfig;
}
