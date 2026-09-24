/**
 * `raiken config` — set the AI provider, API key, model, and base URL from
 * the terminal, writing to the same `raiken.config.json#ai` section the
 * dashboard's Settings → AI Provider panel does (via the same
 * `ConfigApplication.updateConfig` path, so both surfaces stay in sync and get
 * the same validation).
 *
 * Two intentional paths:
 *   - Flags are kept for scripts and automation.
 *   - `raiken config` and `/config` use one guided flow: provider → key →
 *     model → review/save. Both persist the same per-project configuration
 *     the dashboard uses.
 */

import {
    type ConfigApplication,
    createProjectApplication,
    getProvider,
    listProviderModels,
    listProviders,
    type ModelInfo,
    type ProviderDefinition,
    readApiKeyFromEnv,
    resolveAIConfig,
} from "@raiken/core";
import {
    AI_PROVIDER_IDS,
    type AIProviderId,
    type AiConfigPatchOptions,
    aiConfigWithRememberedKey,
    buildAiConfigPatch,
    getStoredProviderKeys,
} from "@raiken/shared/server";
import chalk from "chalk";
import ora from "ora";
import { accent, dim } from "../agent-stream";
import { CLI_EXIT } from "../errors";
import { cliExit } from "../cli/exit";

type ConfigApp = ConfigApplication;
type ReplAsk = (query: string) => Promise<string | null>;
type StoredProviderKeys = Partial<Record<AIProviderId, string>>;

const KNOWN_KEY_PREFIXES = [
    "sk-or-v1-",
    "sk-ant-",
    "sk-proj-",
    "sk-",
    "gsk_",
    "AIza",
    "pplx-",
    "xai-",
];

/**
 * Heuristic: does this look like a pasted API key rather than a chat
 * message or another command? Used so `/config sk-or-v1-...` (no flags) and
 * a bare key pasted at the main chat prompt both "just work" — mirroring how
 * OpenRouter (and most providers) onboard: paste the key, nothing else to
 * configure. Deliberately conservative (single token, no spaces) so a
 * hyphenated chat request like "test-the-login-flow" is never mistaken for
 * a key.
 */
export function looksLikeApiKey(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed)) return false;
    if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) return false;
    if (trimmed.length >= 20 && KNOWN_KEY_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
    // Generic fallback for providers/formats not in the known-prefix list:
    // long, and mixing letters + digits — plain phrases rarely have digits.
    return trimmed.length >= 32 && /[0-9]/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

export type { AiConfigPatchOptions as ConfigPatchOptions };
export { buildAiConfigPatch };

export interface ConfigCommandOptions extends AiConfigPatchOptions {
    /** Show the provider catalog + current AI config; don't change anything. */
    list?: boolean;
    json?: boolean;
    /** Set by the REPL's `/config` (vs. a standalone `raiken config`). */
    fromRepl?: boolean;
    /** Internal guided-flow preselection, e.g. `/config deepseek`. */
    initialProvider?: AIProviderId;
    /** Internal override used by `raiken init` without changing process.cwd(). */
    projectPath?: string;
    /**
     * The REPL's own single-line, cancelable prompt (chat.ts's
     * `askCancelable`), used to run {@link runReplConfigWizard} when
     * `/config` is invoked with no flags. `@inquirer/prompts` can't be used
     * here — it opens a second readline on top of the REPL's own (double
     * echo, raw-mode desync on teardown; see `organizeCommand`'s `confirm`
     * for the same issue), so the REPL needs its own prompt primitive
     * instead. Optional: without it, `/config` (no flags) falls back to the
     * static catalog + hint.
     */
    replAsk?: ReplAsk;
    /**
     * A REPL-native prompt that does not echo its answer. The CLI uses this
     * for API keys when available; tests and non-interactive callers can
     * safely fall back to {@link replAsk}.
     */
    replAskSecret?: ReplAsk;
}

export async function configCommand(
    section: string | undefined,
    options: ConfigCommandOptions,
): Promise<void> {
    if (section && section !== "ai") {
        const providerId = section.trim().toLowerCase();
        if ((AI_PROVIDER_IDS as readonly string[]).includes(providerId)) {
            // A positional provider starts the guided flow with that provider
            // selected. Scripts can still use `--provider` for an immediate,
            // non-interactive update.
            if (!options.provider) {
                options = { ...options, initialProvider: providerId as AIProviderId };
            }
        } else if (looksLikeApiKey(section)) {
            console.error(
                chalk.yellow(
                    "For security, do not put API keys in command arguments. " +
                        "Run `raiken config` and paste it into the masked key prompt.",
                ),
            );
            cliExit(CLI_EXIT.CONFIG_AUTH);
            return;
        } else {
            console.error(
                chalk.red(
                    `✗ Unknown provider or config section: "${section}". ` +
                        `Use "ai" or a provider id.`,
                ),
            );
            cliExit(CLI_EXIT.CONFIG_AUTH);
            return;
        }
    }

    const projectPath = options.projectPath ?? process.cwd();
    const app = createProjectApplication(projectPath);

    if (options.list) {
        await printProviderList(app.config, options.json);
        return;
    }

    const hasDirectFlags = Boolean(
        options.provider || options.apiKey || options.model || options.baseUrl || options.unsetKey,
    );

    if (hasDirectFlags) {
        await applyDirectFlags(app.config, projectPath, options);
        return;
    }

    if (options.fromRepl && options.replAsk) {
        await runReplConfigWizard(
            app.config,
            projectPath,
            options.replAsk,
            options.replAskSecret ?? options.replAsk,
            options.initialProvider,
        );
        return;
    }

    if (options.fromRepl || !process.stdin.isTTY) {
        await printProviderList(app.config, false);
        // Note the command prefix explicitly (`/config` vs `raiken config`) —
        // without it, typing just the flags at the next prompt gets sent as a
        // plain chat message instead of running the command.
        const cmd = options.fromRepl ? "/config" : "raiken config";
        console.log(
            dim(
                `\n  Paste a key to use with the current provider: ${cmd} <api-key>` +
                    `\n  Or set specific values: ${cmd} --provider openai --api-key sk-... --model gpt-4o` +
                    (options.fromRepl
                        ? ""
                        : "\n  Or run `raiken config` in an interactive terminal for the setup wizard."),
            ),
        );
        return;
    }

    await runInteractiveWizard(app.config, projectPath, options.initialProvider);
}

async function printProviderList(config: ConfigApp, json: boolean | undefined): Promise<void> {
    const { providers, current } = config.listAIProviders();

    if (json) {
        process.stdout.write(`${JSON.stringify({ providers, current }, null, 2)}\n`);
        return;
    }

    const currentProvider = providers.find((p) => p.id === current.provider);
    console.log(accent("\n  AI configuration"));
    console.log(dim(`  Provider   ${currentProvider?.label ?? current.provider}`));
    console.log(dim(`  Model      ${current.model}`));
    console.log(
        dim("  API key    ") +
            (current.hasKey
                ? chalk.green(
                      `configured${current.apiKeyEnvVar ? ` (env: ${current.apiKeyEnvVar})` : " (config)"}`,
                  )
                : chalk.yellow("missing")),
    );

    console.log(accent("\n  Providers"));
    for (const p of providers) {
        const marker = p.id === current.provider ? accent("›") : " ";
        const keyState =
            p.envVars.length === 0 ? dim("n/a") : p.hasKey ? chalk.green("✓") : dim("✗");
        console.log(`  ${marker} ${p.id.padEnd(12)} ${p.label.padEnd(24)} key: ${keyState}`);
    }
    console.log("");
}

async function applyDirectFlags(
    config: ConfigApp,
    projectPath: string,
    options: ConfigCommandOptions,
): Promise<void> {
    const current = resolveAIConfig(projectPath);
    const storedKeys = getStoredProviderKeys(projectPath);
    const requestedProviderId = options.provider?.trim().toLowerCase();
    const requestedProvider =
        requestedProviderId && (AI_PROVIDER_IDS as readonly string[]).includes(requestedProviderId)
            ? getProvider(requestedProviderId)
            : undefined;
    const switchingProvider = Boolean(
        requestedProvider && requestedProvider.id !== current.provider,
    );
    const rememberedTargetKey = requestedProvider ? storedKeys[requestedProvider.id] : undefined;

    if (requestedProvider?.id === "custom" && switchingProvider && !options.baseUrl) {
        console.error(
            chalk.red(
                "✗ Custom providers require --base-url when switching providers. " +
                    "Example: raiken config custom --base-url http://localhost:1234/v1 --model my-model",
            ),
        );
        cliExit(CLI_EXIT.USAGE);
        return;
    }

    // Provider defaults belong to the provider, not the previous config. On
    // a direct provider switch, retain an explicitly supplied model/base URL
    // but otherwise replace stale values with the new provider's defaults.
    // The config has one shared key slot; clearing a persisted previous key
    // prevents accidentally sending (say) an OpenRouter key to Anthropic.
    const effectiveOptions: ConfigCommandOptions =
        requestedProvider && switchingProvider
            ? {
                  ...options,
                  model: options.model ?? requestedProvider.defaultModel,
                  baseUrl: options.baseUrl ?? (requestedProvider.defaultBaseURL || undefined),
                  apiKey: options.apiKey ?? rememberedTargetKey,
                  unsetKey: options.unsetKey,
              }
            : options;

    const built = buildAiConfigPatch(effectiveOptions);
    if ("error" in built) {
        console.error(chalk.red(`✗ ${built.error}`));
        cliExit(CLI_EXIT.USAGE);
        return;
    }

    const targetProviderId =
        typeof built.patch.provider === "string" &&
        (AI_PROVIDER_IDS as readonly string[]).includes(built.patch.provider)
            ? (built.patch.provider as AIProviderId)
            : current.provider;
    const aiPatch = aiConfigWithRememberedKey(built.patch, targetProviderId, storedKeys);
    const clearSecrets = [
        ...(built.clearSecrets ?? []),
        ...(options.unsetKey ? [`ai.apiKeys.${targetProviderId}`] : []),
    ];
    const result = await config.updateConfig({
        config: { ai: aiPatch },
        ...(clearSecrets.length > 0 ? { clearSecrets } : {}),
    });
    if (!result.success) {
        console.error(chalk.red("\n✗ Invalid configuration:"));
        for (const err of result.errors ?? []) console.error(chalk.red(`  - ${err}`));
        cliExit(CLI_EXIT.USAGE);
        return;
    }

    const resolved = resolveAIConfig(projectPath);
    const provider = getProvider(resolved.provider);

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    success: true,
                    provider: resolved.provider,
                    model: resolved.model,
                    hasKey: Boolean(resolved.apiKey),
                    apiKeySource: resolved.apiKeySource,
                },
                null,
                2,
            )}\n`,
        );
        return;
    }

    console.log(chalk.green("\n✓ Updated raiken.config.json"));
    console.log(dim(`  Provider   ${provider.label} (${resolved.provider})`));
    console.log(dim(`  Model      ${resolved.model}`));
    console.log(
        dim("  API key    ") +
            (resolved.apiKey
                ? chalk.green(`configured (${resolved.apiKeySource})`)
                : chalk.yellow("not set")),
    );
    if (resolved.apiKeySource === "env" && (options.apiKey || options.unsetKey)) {
        console.log(
            chalk.yellow(
                `  ⚠ ${provider.envVars[0]} is set in your environment and takes precedence over ` +
                    "the key you just saved.",
            ),
        );
    }
    if (options.apiKey) {
        console.error(
            chalk.yellow(
                "  ⚠ This key was supplied on the command line, so it may be visible in your shell history " +
                    "or process list. Prefer `raiken config` (interactive) or an environment variable next time.",
            ),
        );
    }
    console.log(dim("\n  Run `raiken status` to verify.\n"));
}

function maskApiKey(key: string): string {
    if (key.length <= 8) return "•".repeat(Math.max(key.length, 4));
    return `${key.slice(0, 4)}${"•".repeat(6)}${key.slice(-4)}`;
}

type ProviderKeyState =
    | { kind: "environment"; label: string; envVar: string }
    | { kind: "saved"; label: string; key: string }
    | { kind: "not-required"; label: string }
    | { kind: "missing"; label: string };

interface ProviderSetupOption {
    provider: ProviderDefinition;
    keyState: ProviderKeyState;
}

interface ModelPrompt {
    provider: ProviderDefinition;
    models: ModelInfo[];
    defaultModel: string;
    fetchError?: string;
    showingRecommendedOnly: boolean;
}

interface SetupSummary {
    provider: ProviderDefinition;
    model: string;
    baseURL?: string;
    keyDescription: string;
}

interface GuidedSetupPrompts {
    chooseProvider: (input: {
        providers: ProviderSetupOption[];
        currentProvider: AIProviderId;
        initialProvider?: AIProviderId;
    }) => Promise<AIProviderId | null>;
    confirmSavedKey: (provider: ProviderDefinition, key: string) => Promise<boolean | null>;
    askApiKey: (provider: ProviderDefinition) => Promise<string | null>;
    askBaseURL: (provider: ProviderDefinition, initialValue?: string) => Promise<string | null>;
    chooseModel: (input: ModelPrompt) => Promise<string | null>;
    confirmSave: (summary: SetupSummary) => Promise<boolean | null>;
    fetchModels: (
        load: () => Promise<{ models: ModelInfo[]; error?: string }>,
    ) => Promise<{ models: ModelInfo[]; error?: string }>;
    message: (message: string) => void;
}

function getProviderKeyState(
    provider: ProviderDefinition,
    storedKeys: StoredProviderKeys,
): ProviderKeyState {
    if (provider.envVars.length === 0) {
        return { kind: "not-required", label: "no key needed" };
    }
    const envKey = readApiKeyFromEnv(provider.id);
    if (envKey) {
        return {
            kind: "environment",
            label: `using ${provider.envVars[0]}`,
            envVar: provider.envVars[0],
        };
    }
    const savedKey = storedKeys[provider.id];
    if (savedKey) {
        return { kind: "saved", label: "saved in this project", key: savedKey };
    }
    return { kind: "missing", label: "needs a key" };
}

/**
 * One provider/key/model/save state machine shared by `raiken config` and
 * `/config`. The two entry points only supply terminal-specific prompt
 * adapters, so they cannot drift into different setup experiences.
 */
async function runGuidedConfigWizard(
    config: ConfigApp,
    projectPath: string,
    prompts: GuidedSetupPrompts,
    initialProvider?: AIProviderId,
): Promise<void> {
    const current = resolveAIConfig(projectPath);
    const storedKeys = getStoredProviderKeys(projectPath);
    const providers = listProviders();
    const providerOptions = providers.map((provider) => ({
        provider,
        keyState: getProviderKeyState(provider, storedKeys),
    }));
    const providerId = await prompts.chooseProvider({
        providers: providerOptions,
        currentProvider: current.provider,
        initialProvider,
    });
    if (!providerId) return;

    const provider = getProvider(providerId);
    const switchedProvider = provider.id !== current.provider;
    const keyState = getProviderKeyState(provider, storedKeys);
    let apiKeyPatch: string | undefined;
    let keyDescription: string;

    if (keyState.kind === "not-required") {
        apiKeyPatch = switchedProvider ? "" : undefined;
        keyDescription = "not required";
        prompts.message(`${provider.label} does not require an API key.`);
    } else if (keyState.kind === "environment") {
        // Never copy environment credentials into raiken.config.json.
        apiKeyPatch = switchedProvider ? "" : undefined;
        keyDescription = `using ${keyState.envVar} from your environment`;
        prompts.message(
            `${keyState.envVar} is set. Raiken will use it without saving it to this project.`,
        );
    } else if (keyState.kind === "saved") {
        const keepSavedKey = await prompts.confirmSavedKey(provider, keyState.key);
        if (keepSavedKey === null) return;
        if (keepSavedKey) {
            apiKeyPatch = switchedProvider ? keyState.key : undefined;
            keyDescription = "saved in this project's gitignored raiken.config.json";
        } else {
            const replacement = await prompts.askApiKey(provider);
            if (replacement === null) return;
            if (!replacement.trim()) {
                prompts.message("No replacement key was entered. Setup was not changed.");
                return;
            }
            apiKeyPatch = replacement.trim();
            keyDescription = "will be saved in this project's gitignored raiken.config.json";
        }
    } else {
        const entered = await prompts.askApiKey(provider);
        if (entered === null) return;
        apiKeyPatch = entered.trim() || undefined;
        keyDescription = entered.trim()
            ? "will be saved in this project's gitignored raiken.config.json"
            : "not set — AI requests will not run until a key is added";
    }

    let baseURL = switchedProvider ? provider.defaultBaseURL || undefined : current.baseURL;
    if (provider.id === "custom") {
        const enteredBaseURL = await prompts.askBaseURL(provider, baseURL);
        if (enteredBaseURL === null) return;
        if (!enteredBaseURL.trim()) {
            prompts.message("A base URL is required for a custom provider. Setup was not changed.");
            return;
        }
        baseURL = enteredBaseURL.trim();
    }

    const defaultModel = switchedProvider ? provider.defaultModel : current.model;
    const effectiveApiKey =
        apiKeyPatch ||
        (keyState.kind === "environment" ? readApiKeyFromEnv(provider.id) : undefined) ||
        (keyState.kind === "saved" ? keyState.key : undefined) ||
        (switchedProvider ? undefined : current.apiKey);
    const canFetchLiveModels = provider.publicCatalog || Boolean(effectiveApiKey);
    let models = provider.recommendedModels;
    let fetchError: string | undefined;

    if (canFetchLiveModels) {
        const catalog = await prompts.fetchModels(() =>
            listProviderModels({ provider: provider.id, apiKey: effectiveApiKey, baseURL }),
        );
        if (catalog.models.length > 0) models = catalog.models;
        fetchError = catalog.error;
    } else {
        prompts.message(
            "No key is configured yet, so Raiken is showing recommended models. You can change this later.",
        );
    }

    const model = await prompts.chooseModel({
        provider,
        models: shortlistModels(models, provider.recommendedModels, defaultModel),
        defaultModel,
        fetchError,
        showingRecommendedOnly: !canFetchLiveModels || Boolean(fetchError),
    });
    if (model === null) return;

    const shouldSave = await prompts.confirmSave({
        provider,
        model,
        baseURL,
        keyDescription,
    });
    if (shouldSave === null || !shouldSave) {
        prompts.message("Setup was not changed.");
        return;
    }

    const result = await config.updateConfig({
        config: {
            ai: aiConfigWithRememberedKey(
                {
                    provider: provider.id,
                    model,
                    ...(baseURL ? { baseURL } : {}),
                    ...(apiKeyPatch !== undefined ? { apiKey: apiKeyPatch } : {}),
                },
                provider.id,
                storedKeys,
            ),
        },
    });
    if (!result.success) {
        prompts.message("Invalid configuration:");
        for (const error of result.errors ?? []) prompts.message(`  - ${error}`);
        return;
    }

    prompts.message(
        "✓ AI setup saved to this project's gitignored raiken.config.json. " +
            "The dashboard uses this same setting.",
    );
}

async function runInteractiveWizard(
    config: ConfigApp,
    projectPath: string,
    initialProvider?: AIProviderId,
): Promise<void> {
    const { confirm, input, password, select } = await import("@inquirer/prompts");
    await runGuidedConfigWizard(
        config,
        projectPath,
        {
            chooseProvider: async ({ providers, currentProvider, initialProvider: initial }) =>
                select<AIProviderId>({
                    message: "1 of 4 — Choose an AI provider",
                    default: initial ?? currentProvider,
                    choices: providers.map(({ provider, keyState }) => ({
                        name: `${provider.label} — ${keyState.label}`,
                        value: provider.id,
                        description: provider.description,
                    })),
                }),
            confirmSavedKey: async (provider, key) =>
                confirm({
                    message: `2 of 4 — Keep the saved ${provider.label} key (${maskApiKey(key)})?`,
                    default: true,
                }),
            askApiKey: async (provider) =>
                password({
                    message:
                        `2 of 4 — Paste your ${provider.label} API key ` +
                        "(saved only in this project's gitignored raiken.config.json; Enter to skip)",
                    mask: "*",
                }),
            askBaseURL: async (provider, initialValue) =>
                input({
                    message: `Custom endpoint for ${provider.label}`,
                    default: initialValue || undefined,
                    validate: (value) => (value.trim() ? true : "Base URL is required"),
                }),
            chooseModel: async ({
                provider,
                models,
                defaultModel,
                fetchError,
                showingRecommendedOnly,
            }) => {
                if (fetchError) {
                    console.log(
                        chalk.yellow(
                            `  Couldn't load ${provider.label}'s live catalog. Showing recommended models instead.`,
                        ),
                    );
                } else if (showingRecommendedOnly) {
                    console.log(
                        dim("  Recommended models are shown until an API key is configured."),
                    );
                }
                const manual = "__manual__";
                const selected = await select({
                    message: "3 of 4 — Choose a model",
                    default: models.some((model) => model.id === defaultModel)
                        ? defaultModel
                        : (models[0]?.id ?? manual),
                    choices: [
                        ...models.map((model) => ({
                            name: model.description
                                ? `${model.name} — ${model.description}`
                                : model.name,
                            value: model.id,
                        })),
                        { name: "Enter a model ID manually", value: manual },
                    ],
                });
                return selected === manual
                    ? input({ message: "Model ID", default: defaultModel })
                    : selected;
            },
            confirmSave: async (summary) => {
                console.log(accent("\n  4 of 4 — Review"));
                console.log(dim(`  Provider   ${summary.provider.label}`));
                console.log(dim(`  Model      ${summary.model}`));
                if (summary.baseURL) console.log(dim(`  Endpoint   ${summary.baseURL}`));
                console.log(dim(`  API key    ${summary.keyDescription}`));
                return confirm({ message: "Save this configuration?", default: true });
            },
            fetchModels: async (load) => {
                const spinner = ora({
                    text: "Checking available models…",
                    spinner: "dots",
                }).start();
                const result = await load();
                if (result.error) spinner.stop();
                else spinner.succeed("Models ready");
                return result;
            },
            message: (message) => console.log(dim(`  ${message}`)),
        },
        initialProvider,
    );
}

/** Match a `/config` provider-picker answer against a 1-based index or a provider id. */
function resolveProviderAnswer(
    answer: string,
    providers: ProviderDefinition[],
    currentProviderId: string,
): AIProviderId | null {
    const trimmed = answer.trim();
    if (!trimmed) return currentProviderId as AIProviderId;
    const asIndex = Number(trimmed);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= providers.length) {
        return providers[asIndex - 1].id;
    }
    const asId = trimmed.toLowerCase();
    if ((AI_PROVIDER_IDS as readonly string[]).includes(asId)) return asId as AIProviderId;
    return null;
}

/**
 * Match a `/config` model-picker answer against a 1-based index into the
 * listed models, a model id typed directly (doesn't have to be in the
 * list — some providers' catalogs are incomplete or stale), or Enter for
 * the default.
 */
function resolveModelAnswer(answer: string, models: ModelInfo[], defaultModel: string): string {
    const trimmed = answer.trim();
    if (!trimmed) return defaultModel;
    const asIndex = Number(trimmed);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= models.length) {
        return models[asIndex - 1].id;
    }
    return trimmed;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const MODEL_SHORTLIST_CAP = 12;

/**
 * Picks a terminal-friendly subset of `models` to print as a numbered list.
 * Providers with a small catalog (most of them) just get everything back
 * unchanged. Providers with a large public catalog (OpenRouter returns
 * 300+) get the provider's own hand-curated `recommendedModels` first —
 * matched by id, since a model already present in the live results keeps
 * `source: "live"` after the live/recommended merge — padded out to the
 * cap with whatever else came back live. Anything not shown is still
 * reachable by typing its id directly at the prompt.
 */
function shortlistModels(
    models: ModelInfo[],
    recommended: ModelInfo[],
    defaultModel: string,
): ModelInfo[] {
    if (models.length <= MODEL_SHORTLIST_CAP) return models;
    const recommendedIds = new Set(recommended.map((m) => m.id));
    const byId = new Map(models.map((m) => [m.id, m]));
    const shortlist: ModelInfo[] = [];
    const used = new Set<string>();
    const add = (m: ModelInfo | undefined) => {
        if (!m || used.has(m.id)) return;
        used.add(m.id);
        shortlist.push(m);
    };
    add(byId.get(defaultModel));
    for (const id of recommendedIds) add(byId.get(id) ?? recommended.find((m) => m.id === id));
    for (const m of models) {
        if (shortlist.length >= MODEL_SHORTLIST_CAP) break;
        add(m);
    }
    return shortlist;
}

/**
 * `/config` with no flags, run from inside the live REPL. A shorter version
 * of {@link runInteractiveWizard} (provider → key → model; base URL is only
 * asked for the "custom" provider) built on the REPL's own cancelable
 * question/answer prompt instead of `@inquirer/prompts` — see the
 * `replAsk` doc on {@link ConfigCommandOptions} for why. Ctrl-C at any step
 * cancels that prompt and aborts the wizard without saving, same as every
 * other cancelable REPL prompt.
 */
export async function runReplConfigWizard(
    config: ConfigApp,
    projectPath: string,
    ask: ReplAsk,
    askSecret: ReplAsk = ask,
    initialProvider?: AIProviderId,
): Promise<void> {
    await runGuidedConfigWizard(
        config,
        projectPath,
        {
            chooseProvider: async ({ providers, currentProvider, initialProvider: initial }) => {
                console.log(accent("\n  1 of 4 — Choose an AI provider"));
                providers.forEach(({ provider, keyState }, index) => {
                    const marker = provider.id === (initial ?? currentProvider) ? accent("›") : " ";
                    console.log(
                        `  ${marker} ${dim(`${index + 1}.`.padEnd(4))}` +
                            `${provider.label.padEnd(24)} ${dim(keyState.label)}`,
                    );
                });
                const answer = await ask(
                    dim(
                        `\n  Provider [1-${providers.length}, id, or Enter to keep ${initial ?? currentProvider}] › `,
                    ),
                );
                if (answer === null) return null;
                const providerId = resolveProviderAnswer(
                    answer,
                    providers.map(({ provider }) => provider),
                    initial ?? currentProvider,
                );
                if (!providerId) {
                    console.log(
                        chalk.red(`  Unknown provider: "${answer.trim()}". Setup was not changed.`),
                    );
                }
                return providerId;
            },
            confirmSavedKey: async (provider, key) => {
                const answer = await ask(
                    dim(
                        `  2 of 4 — Keep the saved ${provider.label} key (${maskApiKey(key)})? [Y/n] › `,
                    ),
                );
                if (answer === null) return null;
                return !["n", "no"].includes(answer.trim().toLowerCase());
            },
            askApiKey: (provider) =>
                askSecret(
                    dim(
                        `  2 of 4 — Paste your ${provider.label} API key ` +
                            "(saved only in this project's gitignored raiken.config.json; Enter to skip) › ",
                    ),
                ),
            askBaseURL: (provider, initialValue) =>
                ask(
                    dim(
                        `  Custom endpoint for ${provider.label}` +
                            `${initialValue ? ` [${initialValue}]` : ""} › `,
                    ),
                ).then((answer) => answer?.trim() || initialValue || ""),
            chooseModel: async ({
                provider,
                models,
                defaultModel,
                fetchError,
                showingRecommendedOnly,
            }) => {
                if (fetchError) {
                    console.log(
                        chalk.yellow(
                            `  Couldn't load ${provider.label}'s live catalog. Showing recommended models instead.`,
                        ),
                    );
                } else if (showingRecommendedOnly) {
                    console.log(
                        dim("  Recommended models are shown until an API key is configured."),
                    );
                }
                models.forEach((model, index) => {
                    const marker = model.id === defaultModel ? accent("›") : " ";
                    const label = model.description
                        ? `${model.name}  ${dim(truncate(model.description, 70))}`
                        : model.name;
                    console.log(`  ${marker} ${dim(`${index + 1}.`.padEnd(4))}${label}`);
                });
                const answer = await ask(
                    dim(
                        `\n  3 of 4 — Model [1-${models.length}, id, or Enter for ${defaultModel}] › `,
                    ),
                );
                if (answer === null) return null;
                return resolveModelAnswer(answer, models, defaultModel);
            },
            confirmSave: async (summary) => {
                console.log(accent("\n  4 of 4 — Review"));
                console.log(dim(`  Provider   ${summary.provider.label}`));
                console.log(dim(`  Model      ${summary.model}`));
                if (summary.baseURL) console.log(dim(`  Endpoint   ${summary.baseURL}`));
                console.log(dim(`  API key    ${summary.keyDescription}`));
                const answer = await ask(dim("\n  Save this configuration? [Y/n] › "));
                if (answer === null) return null;
                return !["n", "no"].includes(answer.trim().toLowerCase());
            },
            fetchModels: async (load) => {
                console.log(dim("  Checking available models…"));
                return load();
            },
            message: (message) => console.log(dim(`  ${message}`)),
        },
        initialProvider,
    );
}
