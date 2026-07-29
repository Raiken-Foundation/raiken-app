import type { PublicRaikenConfig } from "@raiken/shared";
import { cloneElement, isValidElement, type ReactElement, useEffect, useId, useState } from "react";
import { AIProviderPanel } from "../components/ai-provider-panel";
import { Header } from "../components/header";
import { trpc } from "../utils/trpc";

function optionalNumber(value: string): number | undefined {
    if (value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

interface RaikenConfig {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    ai: {
        provider: string;
        model: string;
        baseURL?: string;
        maxTokens?: number;
        temperature?: number;
    };
    auth?: {
        storageStatePath?: string;
        baseUrl?: string;
        loginPath?: string;
        credentials?: {
            username?: string;
            password?: string;
            usernameEnv?: string;
            passwordEnv?: string;
        };
        customLoginScript?: string;
    };
    features: { video: boolean; screenshots: boolean; tracing: boolean; network: boolean };
    indexing?: { fullScan: boolean };
    discovery?: {
        maxPages?: number;
        maxDepth?: number;
        maxConcurrency?: number;
        timeout?: number;
        excludePatterns?: string[];
        pauseOnAuth?: boolean;
        maxRunTimeMs?: number;
        preserveQueryParams?: boolean;
    };
    browser: { defaultBrowser: string; headless: boolean; timeout: number; retries: number };
    autonomy?: {
        autoSaveTests: boolean;
        autoRunTests: boolean;
        autoCorrect: "suggest" | "apply" | "off";
        autoLearn: string;
        maxRetries: number;
    };
    integrations?: {
        provider?: "github" | "jira" | "linear";
        github?: { token?: string; owner?: string; repo?: string };
        jira?: { host?: string; email?: string; apiToken?: string; projectKey?: string };
        linear?: { teamKey?: string };
        branchPatterns?: string[];
    };
}

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
 * Build the write-only save payload. Public configuration data never contains
 * secret values, so only an explicitly typed draft can add a credential back
 * to this patch. Blank drafts are omitted and therefore preserve saved keys.
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

const defaultConfig: RaikenConfig = {
    projectType: "generic",
    testDirectory: "e2e",
    playwrightConfig: "playwright.config.ts",
    outputFormats: ["typescript"],
    ai: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        maxTokens: 4000,
        temperature: 0.7,
    },
    auth: {},
    features: { video: true, screenshots: true, tracing: false, network: true },
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
    browser: { defaultBrowser: "chromium", headless: true, timeout: 30000, retries: 1 },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
        maxRetries: 2,
    },
    integrations: {
        provider: "github",
        branchPatterns: [],
    },
};

type Section =
    | "general"
    | "ai"
    | "auth"
    | "browser"
    | "discovery"
    | "advanced"
    | "features"
    | "autonomy"
    | "integrations";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
    {
        id: "general",
        label: "General",
        icon: "M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75",
    },
    {
        id: "ai",
        label: "AI Provider",
        icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z",
    },
    {
        id: "auth",
        label: "Auth",
        icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
    },
    {
        id: "browser",
        label: "Browser",
        icon: "M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418",
    },
    {
        id: "discovery",
        label: "Discovery",
        icon: "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 0z",
    },
    {
        id: "features",
        label: "Features",
        icon: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z",
    },
    {
        id: "autonomy",
        label: "Autonomy",
        icon: "M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-1.645-7.5h-2.818m2.818 15h-2.818M4.145 4.5h2.818m-2.818 15h2.818",
    },
    {
        id: "integrations",
        label: "Integrations",
        icon: "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244",
    },
    {
        id: "advanced",
        label: "Advanced",
        icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z",
    },
];

export function SettingsView() {
    const [activeSection, setActiveSection] = useState<Section>("general");
    const [form, setForm] = useState<Partial<PublicRaikenConfig>>({});
    const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>({
        aiKeys: {},
        linearApiKey: "",
    });
    const [dirty, setDirty] = useState(false);
    const [saved, setSaved] = useState(false);

    const [saveError, setSaveError] = useState<string | null>(null);

    const configQuery = trpc.getConfig.useQuery();
    const saveMutation = trpc.updateConfig.useMutation({
        onSuccess: (data) => {
            // The server validates the merged config and returns
            // `{ success: false, errors }` for an invalid write instead of
            // throwing — surface those to the user rather than flashing "Saved".
            const res = data as { success: boolean; errors?: string[] };
            if (res && res.success === false) {
                setSaveError(
                    res.errors?.length
                        ? `Invalid configuration — ${res.errors.join("; ")}`
                        : "Invalid configuration.",
                );
                return;
            }
            setDirty(false);
            setSaved(true);
            setSaveError(null);
            configQuery.refetch();
            setTimeout(() => setSaved(false), 2000);
        },
        onError: (error) => {
            setSaveError(error.message || "Failed to save configuration");
        },
    });

    useEffect(() => {
        if (configQuery.data && !dirty) {
            setForm(configQuery.data.config);
            setSecretDrafts({ aiKeys: {}, linearApiKey: "" });
        }
    }, [configQuery.data, dirty]);

    const update = <K extends keyof PublicRaikenConfig>(
        section: K,
        field: string,
        value: unknown,
    ) => {
        setForm((prev) => ({
            ...prev,
            [section]:
                typeof prev[section] === "object" && prev[section] !== null
                    ? { ...(prev[section] as Record<string, unknown>), [field]: value }
                    : { [field]: value },
        }));
        setDirty(true);
        setSaved(false);
    };

    const updateTop = (field: keyof PublicRaikenConfig, value: unknown) => {
        setForm((prev) => ({ ...prev, [field]: value }));
        setDirty(true);
        setSaved(false);
    };

    const handleSave = () => {
        saveMutation.mutate({ config: createSettingsConfigPatch(form, secretDrafts) });
    };

    const handleReset = () => {
        setForm(configQuery.data?.config ?? {});
        setSecretDrafts({ aiKeys: {}, linearApiKey: "" });
        setDirty(false);
    };

    const val = <K extends keyof PublicRaikenConfig>(section: K, field: string): unknown => {
        const s = form[section];
        if (s && typeof s === "object") {
            return (s as Record<string, unknown>)[field];
        }
        return undefined;
    };

    const def = <K extends keyof RaikenConfig>(section: K, field: string): unknown => {
        const s = defaultConfig[section];
        if (s && typeof s === "object") {
            return (s as Record<string, unknown>)[field];
        }
        return undefined;
    };

    // Deep-path variants for settings that nest two or more levels (e.g.
    // `auth.credentials.usernameEnv`, `integrations.github.owner`) — `update`
    // above only supports a single level of nesting under a top-level section.
    const updateAt = (path: string[], value: unknown) => {
        setForm((prev) => {
            const next = structuredClone(prev) as Record<string, unknown>;
            let obj = next;
            for (let i = 0; i < path.length - 1; i++) {
                const key = path[i];
                if (typeof obj[key] !== "object" || obj[key] === null) {
                    obj[key] = {};
                }
                obj = obj[key] as Record<string, unknown>;
            }
            obj[path[path.length - 1]] = value;
            return next as Partial<PublicRaikenConfig>;
        });
        setDirty(true);
        setSaved(false);
    };

    const valAt = (path: string[]): unknown => {
        let obj: unknown = form;
        for (const key of path) {
            if (obj && typeof obj === "object") {
                obj = (obj as Record<string, unknown>)[key];
            } else {
                return undefined;
            }
        }
        return obj;
    };

    const activeAiProvider =
        (val("ai", "provider") as string | undefined) ?? defaultConfig.ai.provider;
    const updateAiKeyDraft = (value: string) => {
        setSecretDrafts((previous) => ({
            ...previous,
            aiKeys: {
                ...previous.aiKeys,
                [activeAiProvider]: value,
            },
        }));
        setDirty(true);
        setSaved(false);
    };

    if (configQuery.isLoading) {
        return (
            <div className="settings-view">
                <Header projectName="Settings" />
                <div className="settings-loading">
                    <div className="loader-spinner" />
                    <span>Loading configuration...</span>
                </div>
                <style>{`
                    .settings-view { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg); color: var(--ink); font-family: var(--mono); overflow: hidden; }
                    .settings-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; flex: 1; color: var(--ink-dim); font-size: 12px; font-family: var(--mono); }
                    .loader-spinner { width: 18px; height: 18px; border: 2px solid var(--hair-strong); border-top-color: var(--accent); border-radius: 50%; animation: q-spin 0.8s linear infinite; }
                `}</style>
            </div>
        );
    }

    if (configQuery.isError) {
        return (
            <div className="settings-view">
                <Header projectName="Settings" />
                <div className="settings-loading">
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--fail)"
                        strokeWidth="1.5"
                        style={{ width: 24, height: 24 }}
                    >
                        <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>Failed to load configuration: {configQuery.error?.message}</span>
                    <button
                        type="button"
                        onClick={() => configQuery.refetch()}
                        style={{
                            padding: "4px 10px",
                            background: "transparent",
                            border: "1px solid var(--accent-dim)",
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: "11.5px",
                            fontFamily: "var(--mono)",
                        }}
                    >
                        retry
                    </button>
                </div>
                <style>{`
                    .settings-view { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg); color: var(--ink); font-family: var(--mono); overflow: hidden; }
                    .settings-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; flex: 1; color: var(--ink-dim); font-size: 12px; font-family: var(--mono); }
                `}</style>
            </div>
        );
    }

    return (
        <div className="settings-view">
            <Header projectName="Settings" />

            <div className="settings-body">
                <nav className="settings-nav" aria-label="Settings sections">
                    {SECTIONS.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className={`nav-item ${activeSection === s.id ? "active" : ""}`}
                            onClick={() => setActiveSection(s.id)}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                aria-hidden="true"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d={s.icon} />
                            </svg>
                            {s.label}
                        </button>
                    ))}
                </nav>

                <main className="settings-main">
                    <div className="settings-header">
                        <div>
                            <h1>{SECTIONS.find((s) => s.id === activeSection)?.label}</h1>
                            <p className="settings-desc">
                                {activeSection === "general" &&
                                    "Project-level settings for test output and configuration paths."}
                                {activeSection === "ai" &&
                                    "Configure the AI provider used for test generation and analysis."}
                                {activeSection === "auth" &&
                                    "Configure how Raiken authenticates against your app during discovery and test runs."}
                                {activeSection === "browser" &&
                                    "Browser settings for running Playwright tests."}
                                {activeSection === "discovery" &&
                                    "Control how Raiken crawls and discovers your site structure."}
                                {activeSection === "advanced" &&
                                    "Advanced discovery limits and indexing behavior. Most projects won't need to change these."}
                                {activeSection === "features" &&
                                    "Toggle test recording features and artifacts."}
                                {activeSection === "autonomy" &&
                                    "Control how much Raiken does automatically vs. asking for confirmation."}
                                {activeSection === "integrations" &&
                                    "Connect a ticket provider so Raiken can link tests to issues and branches."}
                            </p>
                        </div>
                        <div className="save-bar">
                            {saved && <span className="save-toast">Saved</span>}
                            <button
                                type="button"
                                className="btn-secondary"
                                onClick={handleReset}
                                disabled={!dirty}
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={handleSave}
                                disabled={!dirty || saveMutation.isPending}
                            >
                                {saveMutation.isPending ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>

                    {saveError && (
                        <div className="save-error-banner">
                            <span>Save failed: {saveError}</span>
                            <button
                                type="button"
                                onClick={() => setSaveError(null)}
                                style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--fail)",
                                    cursor: "pointer",
                                    fontSize: "14px",
                                    fontFamily: "var(--mono)",
                                }}
                            >
                                ×
                            </button>
                        </div>
                    )}

                    <div className="field-list">
                        {activeSection === "general" && (
                            <>
                                <FieldGroup
                                    label="Test Directory"
                                    hint="Where generated tests are saved, relative to the project root."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (form.testDirectory as string) ??
                                            defaultConfig.testDirectory
                                        }
                                        onChange={(e) => updateTop("testDirectory", e.target.value)}
                                        placeholder={defaultConfig.testDirectory}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Playwright Config"
                                    hint="Path to your Playwright configuration file."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (form.playwrightConfig as string) ??
                                            defaultConfig.playwrightConfig
                                        }
                                        onChange={(e) =>
                                            updateTop("playwrightConfig", e.target.value)
                                        }
                                        placeholder={defaultConfig.playwrightConfig}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Project Type"
                                    hint="Type of project (generic, react, nextjs, etc.)"
                                >
                                    <input
                                        type="text"
                                        value={
                                            (form.projectType as string) ??
                                            defaultConfig.projectType
                                        }
                                        onChange={(e) => updateTop("projectType", e.target.value)}
                                        placeholder={defaultConfig.projectType}
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "ai" && (
                            <>
                                <AIProviderPanel
                                    provider={val("ai", "provider") as string | undefined}
                                    apiKeyDraft={secretDrafts.aiKeys[activeAiProvider]}
                                    model={val("ai", "model") as string | undefined}
                                    baseURL={val("ai", "baseURL") as string | undefined}
                                    onApiKeyDraftChange={updateAiKeyDraft}
                                    onChange={(field, value) => update("ai", field, value)}
                                />
                                <FieldGroup
                                    label="Max Tokens"
                                    hint={`Maximum tokens per AI request/response (default: ${def("ai", "maxTokens")}).`}
                                >
                                    <input
                                        type="number"
                                        min={1}
                                        step={100}
                                        value={
                                            (val("ai", "maxTokens") as number) ??
                                            (def("ai", "maxTokens") as number)
                                        }
                                        onChange={(e) =>
                                            // Empty input = "use the default", not 0
                                            // (0 fails the schema's positive() check
                                            // with no way to recover from the UI).
                                            update(
                                                "ai",
                                                "maxTokens",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Temperature"
                                    hint="Sampling temperature (0 = deterministic, 2 = most random)."
                                >
                                    <input
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={
                                            (val("ai", "temperature") as number) ??
                                            (def("ai", "temperature") as number)
                                        }
                                        onChange={(e) =>
                                            // Empty input = "use the default", not
                                            // silently committing temperature 0.
                                            update(
                                                "ai",
                                                "temperature",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "auth" && (
                            <>
                                <FieldGroup
                                    label="Storage State Path"
                                    hint="Path to a Playwright storageState JSON file for pre-authenticated sessions."
                                >
                                    <input
                                        type="text"
                                        value={(val("auth", "storageStatePath") as string) ?? ""}
                                        onChange={(e) =>
                                            update("auth", "storageStatePath", e.target.value)
                                        }
                                        placeholder=".raiken/auth-state.json"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Base URL"
                                    hint="Base URL of the application, used to resolve the login path."
                                >
                                    <input
                                        type="text"
                                        value={(val("auth", "baseUrl") as string) ?? ""}
                                        onChange={(e) => update("auth", "baseUrl", e.target.value)}
                                        placeholder="https://app.example.com"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Login Path"
                                    hint="Path to the login page, relative to the base URL."
                                >
                                    <input
                                        type="text"
                                        value={(val("auth", "loginPath") as string) ?? ""}
                                        onChange={(e) =>
                                            update("auth", "loginPath", e.target.value)
                                        }
                                        placeholder="/login"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Username Env Var"
                                    hint="Name of the environment variable holding the test username (never the raw value)."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["auth", "credentials", "usernameEnv"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["auth", "credentials", "usernameEnv"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="RAIKEN_TEST_USERNAME"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Password Env Var"
                                    hint="Name of the environment variable holding the test password (never the raw value)."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["auth", "credentials", "passwordEnv"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["auth", "credentials", "passwordEnv"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="RAIKEN_TEST_PASSWORD"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Custom Login Script"
                                    hint="Path to a script handling non-standard login flows (SSO, MFA, etc.)."
                                >
                                    <input
                                        type="text"
                                        value={(val("auth", "customLoginScript") as string) ?? ""}
                                        onChange={(e) =>
                                            update("auth", "customLoginScript", e.target.value)
                                        }
                                        placeholder="scripts/login.ts"
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "browser" && (
                            <>
                                <FieldGroup
                                    label="Default Browser"
                                    hint="Which browser engine Playwright uses by default."
                                >
                                    <select
                                        value={
                                            (val("browser", "defaultBrowser") as string) ??
                                            defaultConfig.browser.defaultBrowser
                                        }
                                        onChange={(e) =>
                                            update("browser", "defaultBrowser", e.target.value)
                                        }
                                    >
                                        <option value="chromium">Chromium</option>
                                        <option value="firefox">Firefox</option>
                                        <option value="webkit">WebKit</option>
                                    </select>
                                </FieldGroup>
                                <FieldGroup
                                    label="Headless"
                                    hint="Run tests without a visible browser window."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("browser", "headless") as boolean) ??
                                            defaultConfig.browser.headless
                                        }
                                        onChange={(v) => update("browser", "headless", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Timeout (ms)"
                                    hint="Maximum time for each browser action before failing."
                                >
                                    <input
                                        type="number"
                                        min={1000}
                                        step={1000}
                                        value={
                                            (val("browser", "timeout") as number) ??
                                            defaultConfig.browser.timeout
                                        }
                                        onChange={(e) =>
                                            update(
                                                "browser",
                                                "timeout",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Retries"
                                    hint="Number of times to retry a failed test."
                                >
                                    <input
                                        type="number"
                                        min={0}
                                        max={5}
                                        value={
                                            (val("browser", "retries") as number) ??
                                            defaultConfig.browser.retries
                                        }
                                        onChange={(e) =>
                                            update(
                                                "browser",
                                                "retries",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "discovery" && (
                            <>
                                <FieldGroup
                                    label="Max Pages"
                                    hint={`Maximum pages to discover in a single crawl session (default: ${def("discovery", "maxPages")}).`}
                                >
                                    <input
                                        type="number"
                                        min={1}
                                        value={
                                            (val("discovery", "maxPages") as number) ??
                                            (def("discovery", "maxPages") as number)
                                        }
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "maxPages",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Max Depth"
                                    hint={`How many navigation levels deep to crawl (default: ${def("discovery", "maxDepth")}).`}
                                >
                                    <input
                                        type="number"
                                        min={1}
                                        max={20}
                                        value={
                                            (val("discovery", "maxDepth") as number) ??
                                            (def("discovery", "maxDepth") as number)
                                        }
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "maxDepth",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Concurrency"
                                    hint="Number of pages crawled simultaneously."
                                >
                                    <input
                                        type="number"
                                        min={1}
                                        max={10}
                                        value={
                                            (val("discovery", "maxConcurrency") as number) ??
                                            (def("discovery", "maxConcurrency") as number)
                                        }
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "maxConcurrency",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Timeout (ms)"
                                    hint="Per-page navigation timeout."
                                >
                                    <input
                                        type="number"
                                        min={1000}
                                        step={1000}
                                        value={
                                            (val("discovery", "timeout") as number) ??
                                            (def("discovery", "timeout") as number)
                                        }
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "timeout",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Pause on Auth"
                                    hint="Pause crawling when an authentication wall is detected."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("discovery", "pauseOnAuth") as boolean) ?? true
                                        }
                                        onChange={(v) => update("discovery", "pauseOnAuth", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Exclude Patterns"
                                    hint="Comma-separated URL patterns to skip (e.g. /admin, /logout)."
                                >
                                    <input
                                        type="text"
                                        value={(
                                            (val("discovery", "excludePatterns") as string[]) ?? []
                                        ).join(", ")}
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "excludePatterns",
                                                e.target.value
                                                    .split(",")
                                                    .map((s) => s.trim())
                                                    .filter(Boolean),
                                            )
                                        }
                                        placeholder="/admin, /logout"
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "advanced" && (
                            <>
                                <FieldGroup
                                    label="Max Run Time (ms)"
                                    hint={`Hard wall-clock cap on a single discovery run; 0 disables (default: ${def("discovery", "maxRunTimeMs")}).`}
                                >
                                    <input
                                        type="number"
                                        min={0}
                                        step={60000}
                                        value={
                                            (val("discovery", "maxRunTimeMs") as number) ??
                                            (def("discovery", "maxRunTimeMs") as number)
                                        }
                                        onChange={(e) =>
                                            update(
                                                "discovery",
                                                "maxRunTimeMs",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Preserve Query Params"
                                    hint="Treat URLs that differ only by query string as distinct routes, instead of collapsing them."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("discovery", "preserveQueryParams") as boolean) ??
                                            false
                                        }
                                        onChange={(v) =>
                                            update("discovery", "preserveQueryParams", v)
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Full Scan Indexing"
                                    hint="Force a full project re-scan for the AST/embeddings index instead of an incremental update."
                                >
                                    <ToggleSwitch
                                        checked={(val("indexing", "fullScan") as boolean) ?? false}
                                        onChange={(v) => update("indexing", "fullScan", v)}
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "features" && (
                            <>
                                <FieldGroup
                                    label="Video Recording"
                                    hint="Record video of test runs for debugging."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("features", "video") as boolean) ??
                                            defaultConfig.features.video
                                        }
                                        onChange={(v) => update("features", "video", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Screenshots"
                                    hint="Capture screenshots on test failure."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("features", "screenshots") as boolean) ??
                                            defaultConfig.features.screenshots
                                        }
                                        onChange={(v) => update("features", "screenshots", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Tracing"
                                    hint="Enable Playwright trace recording for post-mortem debugging."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("features", "tracing") as boolean) ??
                                            defaultConfig.features.tracing
                                        }
                                        onChange={(v) => update("features", "tracing", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Network Logging"
                                    hint="Capture network requests during test runs."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("features", "network") as boolean) ??
                                            defaultConfig.features.network
                                        }
                                        onChange={(v) => update("features", "network", v)}
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "autonomy" && (
                            <>
                                <FieldGroup
                                    label="Auto-save Tests"
                                    hint="Save generated tests without asking for confirmation."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("autonomy", "autoSaveTests") as boolean) ?? false
                                        }
                                        onChange={(v) => update("autonomy", "autoSaveTests", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Auto-run Tests"
                                    hint="Automatically run tests after generating them."
                                >
                                    <ToggleSwitch
                                        checked={
                                            (val("autonomy", "autoRunTests") as boolean) ?? false
                                        }
                                        onChange={(v) => update("autonomy", "autoRunTests", v)}
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Auto-correct Behavior"
                                    hint="How Raiken handles test failures: suggest a diff, auto-apply fixes, or do nothing."
                                >
                                    <select
                                        value={
                                            (val("autonomy", "autoCorrect") as string) ?? "suggest"
                                        }
                                        onChange={(e) =>
                                            update("autonomy", "autoCorrect", e.target.value)
                                        }
                                    >
                                        <option value="suggest">Suggest (show diff)</option>
                                        <option value="apply">Auto-apply</option>
                                        <option value="off">Off</option>
                                    </select>
                                </FieldGroup>
                                <FieldGroup
                                    label="Auto-learn"
                                    hint="How Raiken learns from test outcomes: ask first, learn silently, or disable."
                                >
                                    <select
                                        value={
                                            (val("autonomy", "autoLearn") as string) ?? "confirm"
                                        }
                                        onChange={(e) =>
                                            update("autonomy", "autoLearn", e.target.value)
                                        }
                                    >
                                        <option value="confirm">Confirm first</option>
                                        <option value="auto">Auto (silent)</option>
                                        <option value="off">Off</option>
                                    </select>
                                </FieldGroup>
                                <FieldGroup
                                    label="Max Retries"
                                    hint="Maximum auto-retries on test failure (0 = no retry)."
                                >
                                    <input
                                        type="number"
                                        min={0}
                                        max={10}
                                        value={(val("autonomy", "maxRetries") as number) ?? 2}
                                        onChange={(e) =>
                                            update(
                                                "autonomy",
                                                "maxRetries",
                                                optionalNumber(e.target.value),
                                            )
                                        }
                                    />
                                </FieldGroup>
                            </>
                        )}

                        {activeSection === "integrations" && (
                            <>
                                <FieldGroup
                                    label="Ticket Provider"
                                    hint="Which system Raiken links tests/branches to when resolving ticket references."
                                >
                                    <select
                                        value={
                                            (val("integrations", "provider") as string) ?? "github"
                                        }
                                        onChange={(e) =>
                                            update("integrations", "provider", e.target.value)
                                        }
                                    >
                                        <option value="github">GitHub</option>
                                        <option value="jira">Jira</option>
                                        <option value="linear">Linear</option>
                                    </select>
                                </FieldGroup>
                                <FieldGroup
                                    label="GitHub Owner"
                                    hint="Repository owner/org. Auto-detected from the git remote if left blank."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["integrations", "github", "owner"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["integrations", "github", "owner"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="my-org"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="GitHub Repo"
                                    hint="Repository name. Auto-detected from the git remote if left blank."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["integrations", "github", "repo"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["integrations", "github", "repo"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="my-repo"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Jira Base URL"
                                    hint="Your Jira instance's base URL."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["integrations", "jira", "host"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["integrations", "jira", "host"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="https://your-org.atlassian.net"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Jira Project Key"
                                    hint="Project key used when linking tests to Jira issues (e.g. ENG)."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["integrations", "jira", "projectKey"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["integrations", "jira", "projectKey"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="ENG"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Linear API Key"
                                    hint="Personal or workspace API key used to look up Linear issues."
                                >
                                    <input
                                        type="password"
                                        autoComplete="off"
                                        value={secretDrafts.linearApiKey}
                                        onChange={(e) => {
                                            setSecretDrafts((previous) => ({
                                                ...previous,
                                                linearApiKey: e.target.value,
                                            }));
                                            setDirty(true);
                                            setSaved(false);
                                        }}
                                        placeholder={
                                            valAt(["integrations", "linear", "apiKeyPresent"])
                                                ? "Saved — enter a replacement"
                                                : "lin_api_…"
                                        }
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Linear Team Key"
                                    hint="Team key used when linking tests to Linear issues (e.g. ENG)."
                                >
                                    <input
                                        type="text"
                                        value={
                                            (valAt(["integrations", "linear", "teamKey"]) as
                                                | string
                                                | undefined) ?? ""
                                        }
                                        onChange={(e) =>
                                            updateAt(
                                                ["integrations", "linear", "teamKey"],
                                                e.target.value,
                                            )
                                        }
                                        placeholder="ENG"
                                    />
                                </FieldGroup>
                                <FieldGroup
                                    label="Branch Patterns"
                                    hint="One regex per line, used to extract a ticket ID from the current git branch name."
                                    align="start"
                                >
                                    <textarea
                                        rows={4}
                                        value={(
                                            (val("integrations", "branchPatterns") as
                                                | string[]
                                                | undefined) ?? []
                                        ).join("\n")}
                                        onChange={(e) =>
                                            update(
                                                "integrations",
                                                "branchPatterns",
                                                e.target.value
                                                    .split("\n")
                                                    .map((s) => s.trim())
                                                    .filter(Boolean),
                                            )
                                        }
                                        placeholder={"feature/([A-Z]+-\\d+)\nbugfix/([A-Z]+-\\d+)"}
                                    />
                                </FieldGroup>
                            </>
                        )}
                    </div>
                </main>
            </div>

            <style>{`
                .settings-view {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    min-height: 0;
                    background: var(--bg);
                    color: var(--ink);
                    font-family: var(--mono);
                    overflow: hidden;
                }

                .settings-body {
                    display: flex;
                    flex: 1;
                    overflow: hidden;
                }

                .settings-nav {
                    width: 180px;
                    min-width: 180px;
                    border-right: 1px solid var(--hair);
                    background: var(--bg-bar);
                    padding: 0.5rem 0.25rem;
                    display: flex;
                    flex-direction: column;
                    gap: 1px;
                    overflow-y: auto;
                }

                .nav-item {
                    display: flex;
                    align-items: center;
                    gap: 0.4375rem;
                    padding: 0.375rem 0.5rem;
                    background: transparent;
                    border: 0;
                    color: var(--ink-dim);
                    font-family: var(--mono);
                    font-size: 11.5px;
                    cursor: pointer;
                    text-align: left;
                    transition: background 0.12s, color 0.12s;
                    position: relative;
                }

                .nav-item:hover {
                    background: var(--bg-hover);
                    color: var(--ink);
                }

                .nav-item.active {
                    background: var(--accent-soft);
                    color: var(--accent);
                }

                .nav-item.active::before {
                    content: "";
                    position: absolute;
                    left: 0; top: 0; bottom: 0;
                    width: 2px;
                    background: var(--accent);
                }

                .nav-item svg {
                    width: 12px;
                    height: 12px;
                    flex-shrink: 0;
                }

                .settings-main {
                    flex: 1;
                    padding: 1rem 1.25rem;
                    overflow-y: auto;
                    max-width: 720px;
                }

                .settings-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 1rem;
                    padding-bottom: 0.625rem;
                    border-bottom: 1px solid var(--hair);
                    gap: 1rem;
                }

                .settings-header h1 {
                    margin: 0;
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--ink);
                    font-family: var(--mono);
                    display: flex;
                    align-items: center;
                    gap: 0.4375rem;
                }

                .settings-header h1::before {
                    content: "#";
                    color: var(--accent);
                    font-weight: 400;
                }

                .settings-desc {
                    margin: 0.3125rem 0 0;
                    font-size: 11.5px;
                    color: var(--ink-faint);
                    line-height: 1.5;
                }

                .save-bar {
                    display: flex;
                    align-items: center;
                    gap: 0.375rem;
                    flex-shrink: 0;
                }

                .save-toast {
                    font-size: 11px;
                    color: var(--pass);
                    padding: 2px 6px;
                    background: var(--pass-soft);
                    border: 1px solid rgba(111, 184, 111, 0.3);
                    animation: settings-fade-in 0.2s ease;
                    font-family: var(--mono);
                }
                .save-toast::before { content: "✓ "; }

                @keyframes settings-fade-in {
                    from { opacity: 0; transform: translateY(-2px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .btn-secondary {
                    padding: 4px 10px;
                    background: transparent;
                    border: 1px solid var(--hair-strong);
                    color: var(--ink-dim);
                    font-family: var(--mono);
                    font-size: 11.5px;
                    cursor: pointer;
                    transition: background 0.12s, color 0.12s;
                }

                .btn-secondary:hover:not(:disabled) {
                    background: var(--bg-hover);
                    color: var(--ink);
                }

                .btn-secondary:disabled {
                    opacity: 0.4;
                    cursor: default;
                }

                .btn-primary {
                    padding: 4px 12px;
                    background: transparent;
                    border: 1px solid var(--accent-dim);
                    color: var(--accent);
                    font-family: var(--mono);
                    font-size: 11.5px;
                    cursor: pointer;
                    transition: background 0.12s, border-color 0.12s;
                }

                .btn-primary:hover:not(:disabled) {
                    background: var(--accent-dim);
                    border-color: var(--accent);
                }

                .btn-primary:disabled {
                    opacity: 0.4;
                    cursor: default;
                }

                .save-error-banner {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0.4375rem 0.625rem;
                    background: var(--fail-soft);
                    border: 1px solid rgba(215, 92, 92, 0.3);
                    border-left-width: 2px;
                    color: var(--ink);
                    font-size: 11.5px;
                    font-family: var(--mono);
                    margin-bottom: 0.75rem;
                }
                .save-error-banner > span::before {
                    content: "✕ ";
                    color: var(--fail);
                    margin-right: 4px;
                }

                .field-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0;
                }

                .field-group {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 1.25rem;
                    padding: 0.75rem 0;
                    border-bottom: 1px solid var(--hair-soft);
                }

                .field-group:first-child {
                    padding-top: 0;
                }

                .field-label-block {
                    flex: 1;
                }

                .field-label {
                    font-size: 12.5px;
                    font-weight: 500;
                    color: var(--ink);
                    font-family: var(--mono);
                }

                .field-hint {
                    margin: 0.1875rem 0 0;
                    font-size: 11px;
                    color: var(--ink-faint);
                    line-height: 1.5;
                }

                .field-control {
                    flex-shrink: 0;
                    min-width: 200px;
                    max-width: 280px;
                }

                .field-control input[type="text"],
                .field-control input[type="password"],
                .field-control input[type="number"],
                .field-control select,
                .field-control textarea {
                    width: 100%;
                    padding: 0.375rem 0.5rem;
                    background: var(--bg);
                    border: 1px solid var(--hair-strong);
                    border-radius: 0;
                    color: var(--ink);
                    font-family: var(--mono);
                    font-size: 12px;
                    outline: none;
                    transition: border-color 0.12s;
                    box-sizing: border-box;
                }

                .field-control textarea {
                    resize: vertical;
                    line-height: 1.5;
                }

                .field-control input:focus,
                .field-control select:focus,
                .field-control textarea:focus {
                    border-color: var(--accent);
                }

                .field-control select {
                    cursor: pointer;
                    appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a8a8a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 0.5rem center;
                    padding-right: 1.75rem;
                }

                .toggle-switch {
                    position: relative;
                    width: 28px;
                    height: 14px;
                    background: var(--hair-strong);
                    border: 0;
                    border-radius: 0;
                    cursor: pointer;
                    padding: 0;
                    transition: background 0.15s;
                }

                .toggle-switch.on { background: var(--accent); }

                .toggle-knob {
                    position: absolute;
                    top: 2px;
                    left: 2px;
                    width: 10px;
                    height: 10px;
                    background: var(--bg);
                    transition: transform 0.15s;
                    pointer-events: none;
                }

                .toggle-switch.on .toggle-knob {
                    transform: translateX(14px);
                }

                @media (max-width: 768px) {
                    .settings-body { flex-direction: column; }
                    .settings-nav {
                        width: 100%;
                        min-width: unset;
                        border-right: none;
                        border-bottom: 1px solid var(--hair);
                        flex-direction: row;
                        flex-wrap: wrap;
                        padding: 0.375rem;
                    }
                    .settings-main { padding: 0.75rem; }
                    .field-group {
                        flex-direction: column;
                        align-items: flex-start;
                    }
                    .field-control {
                        min-width: unset;
                        max-width: unset;
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
}

function FieldGroup({
    label,
    hint,
    children,
    align = "center",
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
    /** Use "start" for multi-line controls (e.g. a textarea) so the label
     * doesn't center against the control's full height. */
    align?: "center" | "start";
}) {
    const generatedControlId = useId();
    const child = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
    const controlId = child?.props.id ?? generatedControlId;
    const control = child ? cloneElement(child, { id: controlId }) : children;

    return (
        <div
            className="field-group"
            style={{ alignItems: align === "start" ? "flex-start" : "center" }}
        >
            <div className="field-label-block">
                <label className="field-label" htmlFor={controlId}>
                    {label}
                </label>
                {hint && <p className="field-hint">{hint}</p>}
            </div>
            <div className="field-control">{control}</div>
        </div>
    );
}

function ToggleSwitch({
    id,
    checked,
    onChange,
}: {
    id?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <button
            id={id}
            type="button"
            className={`toggle-switch ${checked ? "on" : ""}`}
            onClick={() => onChange(!checked)}
            role="switch"
            aria-checked={checked}
        >
            <span className="toggle-knob" />
        </button>
    );
}

export default SettingsView;
