/**
 * `raiken config` — set the AI provider, API key, model, and base URL from
 * the terminal, writing to the same `raiken.config.json#ai` section the
 * dashboard's Settings → AI Provider panel does (via the same `updateConfig`
 * tRPC procedure, so both surfaces stay in sync and get the same validation).
 *
 * Two ways to use it:
 *   - Flags (scriptable, safe inside the REPL): `raiken config --provider
 *     openai --api-key sk-... --model gpt-4o`
 *   - No flags on a real terminal: an interactive wizard (provider → key →
 *     base URL → model), mirroring the dashboard panel's flow.
 */

import {
    type AIProviderId,
    AI_PROVIDER_IDS,
    getProvider,
    listProviderModels,
    listProviders,
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
    /**
     * Set by the REPL's `/config` — inquirer's prompts would open a second
     * readline on top of the REPL's own (double echo, raw-mode desync on
     * teardown; see `organizeCommand`'s `confirm` for the same issue). The
     * REPL is limited to the flag-driven path; the full wizard is
     * standalone-terminal only.
     */
    fromRepl?: boolean;
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
