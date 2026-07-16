/**
 * `raiken config` — set the AI provider, API key, model, and base URL from
 * the terminal, writing to the same `raiken.config.json#ai` section the
 * dashboard's Settings → AI Provider panel does (via the same `updateConfig`
 * tRPC procedure, so both surfaces stay in sync and get the same validation).
 *
 * Three ways to use it:
 *   - Flags (scriptable): `raiken config --provider openai --api-key sk-...
 *     --model gpt-4o`, or just `raiken config <key>` to set a key for
 *     whichever provider is already active.
 *   - No flags on a real terminal: the full interactive wizard (provider →
 *     key → base URL → model), mirroring the dashboard panel's flow.
 *   - No flags inside the REPL (`/config`): a shorter REPL-native wizard
 *     (provider → key → model) — see {@link runReplConfigWizard}.
 */

import {
    type AIProviderId,
    AI_PROVIDER_IDS,
    getProvider,
    listProviderModels,
    listProviders,
    type ModelInfo,
    type ProviderDefinition,
    readApiKeyFromEnv,
    resolveAIConfig,
} from "@raiken/core";
import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { accent, dim } from "../agent-stream";
import { cliExit } from "../repl/exit";

type Caller = ReturnType<typeof appRouter.createCaller>;

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

export interface ConfigCommandOptions {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    /** Clear the saved key (falls back to an env var, if one is set). */
    unsetKey?: boolean;
    /** Show the provider catalog + current AI config; don't change anything. */
    list?: boolean;
    json?: boolean;
    /** Set by the REPL's `/config` (vs. a standalone `raiken config`). */
    fromRepl?: boolean;
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
    replAsk?: (query: string) => Promise<string | null>;
}

/**
 * Pure patch-builder so the flag precedence/validation is unit-testable
 * without touching the filesystem or a tRPC caller.
 */
export function buildAiConfigPatch(
    options: ConfigCommandOptions,
): { patch: Record<string, unknown> } | { error: string } {
    if (options.provider) {
        const id = options.provider.trim().toLowerCase();
        if (!(AI_PROVIDER_IDS as readonly string[]).includes(id)) {
            return {
                error:
                    `Unknown provider: "${options.provider}". ` +
                    `Valid providers: ${AI_PROVIDER_IDS.join(", ")}`,
            };
        }
    }

    const patch: Record<string, unknown> = {};
    if (options.provider) patch.provider = options.provider.trim().toLowerCase();
    if (options.model) patch.model = options.model;
    if (options.baseUrl) patch.baseURL = options.baseUrl;
    // `--unset-key` wins over a simultaneously-passed `--api-key` — clearing
    // is the more deliberate, less-recoverable action of the two.
    if (options.unsetKey) patch.apiKey = "";
    else if (options.apiKey) patch.apiKey = options.apiKey;

    return { patch };
}

export async function configCommand(
    section: string | undefined,
    options: ConfigCommandOptions,
): Promise<void> {
    if (section && section !== "ai") {
        // `/config sk-or-v1-...` or `raiken config sk-or-v1-...` — a bare key
        // with no flags. Treat it as `--api-key` for whichever provider is
        // already active instead of erroring on an "unknown section". If an
        // explicit `--api-key` was *also* given, that wins and the redundant
        // positional is just ignored (rather than treated as an error).
        if (looksLikeApiKey(section)) {
            if (!options.apiKey) options = { ...options, apiKey: section };
        } else {
            console.error(
                chalk.red(`✗ Unknown config section: "${section}". Only "ai" is supported.`),
            );
            cliExit(1);
            return;
        }
    }

    const projectPath = process.cwd();
    const caller = appRouter.createCaller({ projectPath });

    if (options.list) {
        await printProviderList(caller, options.json);
        return;
    }

    const hasDirectFlags = Boolean(
        options.provider || options.apiKey || options.model || options.baseUrl || options.unsetKey,
    );

    if (hasDirectFlags) {
        await applyDirectFlags(caller, projectPath, options);
        return;
    }

    if (options.fromRepl && options.replAsk) {
        await runReplConfigWizard(caller, projectPath, options.replAsk);
        return;
    }

    if (options.fromRepl || !process.stdin.isTTY) {
        await printProviderList(caller, false);
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

    await runInteractiveWizard(caller, projectPath);
}

async function printProviderList(caller: Caller, json: boolean | undefined): Promise<void> {
    const { providers, current } = await caller.listAIProviders();

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
    caller: Caller,
    projectPath: string,
    options: ConfigCommandOptions,
): Promise<void> {
    const built = buildAiConfigPatch(options);
    if ("error" in built) {
        console.error(chalk.red(`✗ ${built.error}`));
        cliExit(1);
        return;
    }

    const result = await caller.updateConfig({ config: { ai: built.patch } });
    if (!result.success) {
        console.error(chalk.red("\n✗ Invalid configuration:"));
        for (const err of result.errors ?? []) console.error(chalk.red(`  - ${err}`));
        cliExit(1);
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
    console.log(dim("\n  Run `raiken status` to verify.\n"));
}

function maskApiKey(key: string): string {
    if (key.length <= 8) return "•".repeat(Math.max(key.length, 4));
    return `${key.slice(0, 4)}${"•".repeat(6)}${key.slice(-4)}`;
}

async function runInteractiveWizard(caller: Caller, projectPath: string): Promise<void> {
    const { select, input, password, confirm } = await import("@inquirer/prompts");
    const current = resolveAIConfig(projectPath);
    const currentProvider = getProvider(current.provider);

    console.log(accent("\n  Configure AI provider"));
    console.log(
        dim(
            `  Current: ${currentProvider.label} · ${current.model} · key ` +
                `${current.apiKey ? `configured (${current.apiKeySource})` : "missing"}\n`,
        ),
    );

    const providerId = await select<AIProviderId>({
        message: "AI provider",
        default: current.provider,
        choices: listProviders().map((p) => ({
            name: `${p.label}${p.id === current.provider ? "  (current)" : ""}`,
            value: p.id,
            description: p.description,
        })),
    });

    const provider = getProvider(providerId);
    const switchedProvider = providerId !== current.provider;
    const envKey = readApiKeyFromEnv(provider.id);

    // undefined => omit `apiKey` from the patch entirely (leave the saved
    // value on disk untouched). Only ever set to a string we either just
    // typed or are deliberately clearing — never to an env-sourced value,
    // which would silently write an environment secret into
    // raiken.config.json.
    let apiKeyPatch: string | undefined;

    if (provider.envVars.length === 0) {
        console.log(dim(`  ${provider.label} doesn't require an API key.`));
        if (switchedProvider) apiKeyPatch = "";
    } else {
        if (envKey) {
            console.log(
                dim(
                    `  ${provider.envVars[0]} is set in your environment — it will be used at ` +
                        "runtime regardless of what you save here.",
                ),
            );
        }
        const wantsKey = await confirm({
            message: envKey
                ? "Save a key in raiken.config.json anyway (e.g. so the dashboard can use it too)?"
                : "Set an API key now?",
            default: !envKey,
        });
        if (wantsKey) {
            const entered = await password({
                message: `API key${provider.apiKeyPlaceholder ? ` (format: ${provider.apiKeyPlaceholder})` : ""}`,
                mask: "*",
            });
            apiKeyPatch = entered.trim();
            if (!apiKeyPatch && provider.apiKeyUrl) {
                console.log(dim(`  Get a key at: ${provider.apiKeyUrl}`));
            }
        } else if (switchedProvider) {
            // The saved `apiKey` field is shared across providers — leaving
            // a stale key here would resolve as this (wrong) provider's key.
            apiKeyPatch = "";
        }
    }

    let baseURL = switchedProvider ? provider.defaultBaseURL || undefined : current.baseURL;
    const isCustomProvider = provider.id === "custom";
    const needsBaseURLPrompt =
        isCustomProvider ||
        (await confirm({
            message: baseURL
                ? `Override the base URL? (current: ${baseURL})`
                : "Set a custom base URL?",
            default: isCustomProvider,
        }));
    if (needsBaseURLPrompt) {
        baseURL = await input({
            message: "Base URL",
            default: baseURL || provider.defaultBaseURL || undefined,
            validate: (value) => (value.trim() ? true : "Base URL is required"),
        });
    }

    let model = switchedProvider ? provider.defaultModel : current.model;
    const effectiveApiKey =
        apiKeyPatch || envKey || (switchedProvider ? undefined : current.apiKey);
    const spinner = ora({ text: "Fetching available models…", spinner: "dots" }).start();
    const { models, error } = await listProviderModels({
        provider: provider.id,
        apiKey: effectiveApiKey,
        baseURL,
    });
    if (error) spinner.warn(dim(`Could not fetch live models: ${error}`));
    else spinner.stop();

    if (models.length > 0) {
        const MANUAL = "__manual__";
        const picked = await select({
            message: "Model",
            default: models.some((m) => m.id === model) ? model : models[0]?.id,
            choices: [
                ...models.map((m) => ({
                    name: m.description ? `${m.name}  ${dim(m.description)}` : m.name,
                    value: m.id,
                })),
                { name: "Enter manually…", value: MANUAL },
            ],
        });
        model =
            picked === MANUAL
                ? await input({ message: "Model id", default: model || provider.defaultModel })
                : picked;
    } else {
        model = await input({ message: "Model id", default: model || provider.defaultModel });
    }

    console.log(accent("\n  Summary"));
    console.log(dim(`  Provider   ${provider.label} (${provider.id})`));
    console.log(dim(`  Model      ${model}`));
    console.log(dim(`  Base URL   ${baseURL || provider.defaultBaseURL || "(none)"}`));
    console.log(
        dim("  API key    ") +
            (apiKeyPatch
                ? maskApiKey(apiKeyPatch)
                : envKey
                  ? "(using env var)"
                  : current.apiKey && !switchedProvider
                    ? maskApiKey(current.apiKey)
                    : "(none)"),
    );

    const proceed = await confirm({ message: "Save this configuration?", default: true });
    if (!proceed) {
        console.log(dim("\n  Not saved.\n"));
        return;
    }

    const result = await caller.updateConfig({
        config: {
            ai: {
                provider: provider.id,
                model,
                ...(baseURL ? { baseURL } : {}),
                ...(apiKeyPatch !== undefined ? { apiKey: apiKeyPatch } : {}),
            },
        },
    });

    if (!result.success) {
        console.log(chalk.red("\n✗ Invalid configuration:"));
        for (const err of result.errors ?? []) console.log(chalk.red(`  - ${err}`));
        cliExit(1);
        return;
    }

    console.log(chalk.green("\n✓ Saved to raiken.config.json"));
    console.log(dim("  Run `raiken status` to verify.\n"));
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
    caller: Caller,
    projectPath: string,
    ask: (query: string) => Promise<string | null>,
): Promise<void> {
    const current = resolveAIConfig(projectPath);
    const currentProvider = getProvider(current.provider);
    const providers = listProviders();

    console.log(accent("\n  Configure AI provider"));
    console.log(
        dim(
            `  Current: ${currentProvider.label} · ${current.model} · key ` +
                `${current.apiKey ? `configured (${current.apiKeySource})` : "missing"}\n`,
        ),
    );
    providers.forEach((p, i) => {
        const marker = p.id === current.provider ? accent("›") : " ";
        console.log(`  ${marker} ${dim(`${i + 1}.`.padEnd(4))}${p.label.padEnd(24)} ${dim(p.id)}`);
    });

    const providerAnswer = await ask(
        dim(`\n  Provider [1-${providers.length}, id, or Enter to keep it] › `),
    );
    if (providerAnswer === null) return;
    const providerId = resolveProviderAnswer(providerAnswer, providers, current.provider);
    if (!providerId) {
        console.log(chalk.red(`  Unknown provider: "${providerAnswer.trim()}". Not saved.\n`));
        return;
    }
    const provider = getProvider(providerId);
    const switchedProvider = providerId !== current.provider;

    // undefined => omit `apiKey` from the patch entirely (leave the saved
    // value on disk untouched); see the identical comment in
    // `runInteractiveWizard` for why it's never set to an env-sourced value.
    let apiKeyPatch: string | undefined;
    const envKey = readApiKeyFromEnv(provider.id);

    if (provider.envVars.length === 0) {
        console.log(dim(`  ${provider.label} doesn't require an API key.`));
        if (switchedProvider) apiKeyPatch = "";
    } else {
        if (envKey) {
            console.log(
                dim(
                    `  ${provider.envVars[0]} is set in your environment — it will be used at ` +
                        "runtime regardless of what you save here.",
                ),
            );
        }
        const keyAnswer = await ask(
            dim(
                `  API key${provider.apiKeyPlaceholder ? ` (${provider.apiKeyPlaceholder})` : ""} ` +
                    "[Enter to skip] › ",
            ),
        );
        if (keyAnswer === null) return;
        if (keyAnswer.trim()) {
            apiKeyPatch = keyAnswer.trim();
        } else if (switchedProvider && current.apiKey && !envKey) {
            // The saved `apiKey` field is shared across providers — leaving
            // a stale key here would resolve as this (wrong) provider's key.
            apiKeyPatch = "";
        }
    }

    let baseURL = switchedProvider ? provider.defaultBaseURL || undefined : current.baseURL;
    if (provider.id === "custom") {
        const baseUrlAnswer = await ask(dim("  Base URL (required for a custom endpoint) › "));
        if (baseUrlAnswer === null) return;
        if (!baseUrlAnswer.trim()) {
            console.log(chalk.red("  Base URL is required for a custom endpoint. Not saved.\n"));
            return;
        }
        baseURL = baseUrlAnswer.trim();
    }

    const defaultModel = switchedProvider ? provider.defaultModel : current.model;
    const effectiveApiKey = apiKeyPatch || envKey || (switchedProvider ? undefined : current.apiKey);
    const spinner = ora({ text: "Fetching available models…", spinner: "dots" }).start();
    const { models, error } = await listProviderModels({
        provider: provider.id,
        apiKey: effectiveApiKey,
        baseURL,
    });
    if (error) spinner.warn(dim(`Could not fetch live models: ${error}`));
    else spinner.stop();

    let model: string;
    if (models.length > 0) {
        models.forEach((m, i) => {
            const marker = m.id === defaultModel ? accent("›") : " ";
            const label = m.description ? `${m.name}  ${dim(m.description)}` : m.name;
            console.log(`  ${marker} ${dim(`${i + 1}.`.padEnd(4))}${label}`);
        });
        const modelAnswer = await ask(
            dim(`\n  Model [1-${models.length}, id, or Enter for ${defaultModel}] › `),
        );
        if (modelAnswer === null) return;
        model = resolveModelAnswer(modelAnswer, models, defaultModel);
    } else {
        const modelAnswer = await ask(dim(`  Model [Enter for ${defaultModel}] › `));
        if (modelAnswer === null) return;
        model = modelAnswer.trim() || defaultModel;
    }

    console.log(accent("\n  Summary"));
    console.log(dim(`  Provider   ${provider.label} (${provider.id})`));
    console.log(dim(`  Model      ${model}`));
    if (baseURL) console.log(dim(`  Base URL   ${baseURL}`));
    console.log(
        dim("  API key    ") +
            (apiKeyPatch
                ? maskApiKey(apiKeyPatch)
                : envKey
                  ? "(using env var)"
                  : current.apiKey && !switchedProvider
                    ? maskApiKey(current.apiKey)
                    : "(none)"),
    );

    const confirmAnswer = await ask(dim("\n  Save this configuration? [Y/n] › "));
    if (confirmAnswer === null) return;
    if (["n", "no"].includes(confirmAnswer.trim().toLowerCase())) {
        console.log(dim("  Not saved.\n"));
        return;
    }

    const result = await caller.updateConfig({
        config: {
            ai: {
                provider: provider.id,
                model,
                ...(baseURL ? { baseURL } : {}),
                ...(apiKeyPatch !== undefined ? { apiKey: apiKeyPatch } : {}),
            },
        },
    });

    if (!result.success) {
        console.log(chalk.red("\n✗ Invalid configuration:"));
        for (const err of result.errors ?? []) console.log(chalk.red(`  - ${err}`));
        return;
    }

    console.log(chalk.green("\n✓ Saved to raiken.config.json"));
    console.log(dim("  Run `raiken status` to verify.\n"));
}
