import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { trpc } from "../utils/trpc";

interface ProviderOption {
    id: string;
    label: string;
    description: string;
    defaultModel: string;
    defaultBaseURL: string;
    envVars: string[];
    publicCatalog: boolean;
    apiKeyUrl?: string | null;
    apiKeyPlaceholder?: string | null;
    hasKey: boolean;
    recommendedModels?: ModelOption[];
}

interface ModelOption {
    id: string;
    name?: string;
    context?: number;
    description?: string;
    deprecated?: boolean;
    source?: "live" | "recommended";
}

export function normalizeModelOptions(models: ModelOption[], currentModel?: string): ModelOption[] {
    const seen = new Set<string>();
    const normalized: ModelOption[] = [];

    for (const model of models) {
        const id = model.id?.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push({
            ...model,
            id,
            name: model.name?.trim() || id,
        });
    }

    const customId = currentModel?.trim();
    if (customId && !seen.has(customId)) {
        normalized.unshift({
            id: customId,
            name: customId,
            description: "Current custom model",
        });
    }

    return normalized;
}

function optionDomId(listboxId: string, modelId: string): string {
    return `${listboxId}-${modelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

interface AIProviderPanelProps {
    provider: string | undefined;
    apiKey: string | undefined;
    model: string | undefined;
    baseURL: string | undefined;
    onChange: (field: "provider" | "apiKey" | "model" | "baseURL", value: string) => void;
}

/**
 * Provider + dynamic model selector for the Settings view.
 *
 * - Provider list comes from the backend (`listAIProviders`) so adding a new
 *   provider in core/agent/ai-providers.ts automatically surfaces it here.
 * - Model list is fetched on demand per (provider, apiKey) pair via
 *   `listAIModels`. Falls back to a free-form text input if the provider
 *   refuses, so users can still type arbitrary IDs.
 */
export function AIProviderPanel({
    provider,
    apiKey,
    model,
    baseURL,
    onChange,
}: AIProviderPanelProps) {
    const providerId = useId();
    const apiKeyId = useId();
    const modelId = useId();
    const baseUrlId = useId();
    const listboxId = useId();

    const providersQuery = trpc.listAIProviders.useQuery();
    const providers: ProviderOption[] = useMemo(
        () => (providersQuery.data?.providers as ProviderOption[]) ?? [],
        [providersQuery.data],
    );

    const activeProviderId = provider ?? providersQuery.data?.current.provider ?? "openrouter";
    const activeProvider = providers.find((p) => p.id === activeProviderId);

    // Defer model fetch until either the provider exposes a public catalog
    // or the user has supplied a key (avoid spamming /models with no auth).
    const canFetchModels = Boolean(
        activeProvider && (activeProvider.publicCatalog || apiKey || activeProvider.hasKey),
    );

    type ListModelsInput = Exclude<
        Parameters<typeof trpc.listAIModels.useQuery>[0],
        symbol | undefined
    >;
    type ProviderEnum = ListModelsInput["provider"];

    const modelsQuery = trpc.listAIModels.useQuery(
        {
            provider: activeProviderId as ProviderEnum,
            apiKey: apiKey?.trim() || undefined,
            baseURL: baseURL?.trim() || undefined,
        },
        {
            enabled: canFetchModels,
            staleTime: 60_000,
            retry: false,
        },
    );

    const [search, setSearch] = useState("");
    const [open, setOpen] = useState(false);
    const [activeOptionIndex, setActiveOptionIndex] = useState(0);
    const [showAdvancedEndpoint, setShowAdvancedEndpoint] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const showBaseUrl =
        activeProviderId === "custom" ||
        activeProviderId === "ollama" ||
        showAdvancedEndpoint ||
        Boolean(baseURL && baseURL !== activeProvider?.defaultBaseURL);

    useEffect(() => {
        function onClick(e: MouseEvent) {
            if (!wrapperRef.current) return;
            if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, []);

    const allModels = useMemo(() => {
        const liveModels = (modelsQuery.data?.models ?? []) as ModelOption[];
        const providerModels =
            liveModels.length > 0 ? liveModels : (activeProvider?.recommendedModels ?? []);
        return normalizeModelOptions(providerModels, model);
    }, [activeProvider?.recommendedModels, model, modelsQuery.data?.models]);
    const filteredModels = useMemo(() => {
        if (!search.trim()) return allModels;
        const q = search.trim().toLowerCase();
        return allModels.filter(
            (m) =>
                m.id.toLowerCase().includes(q) ||
                (m.name?.toLowerCase().includes(q) ?? false) ||
                (m.description?.toLowerCase().includes(q) ?? false),
        );
    }, [allModels, search]);

    useEffect(() => {
        setActiveOptionIndex(0);
    }, [activeProviderId, filteredModels.length, search]);

    const modelsError = modelsQuery.data?.error;
    const modelsHaveResults = filteredModels.length > 0;
    const isFetchingModels = modelsQuery.isFetching;
    const activeOption = filteredModels[activeOptionIndex];

    function handleProviderChange(nextId: string) {
        const next = providers.find((p) => p.id === nextId);
        onChange("provider", nextId);
        onChange("apiKey", "");
        onChange("model", next?.defaultModel ?? "");
        onChange("baseURL", next?.defaultBaseURL ?? "");
        setSearch("");
        setOpen(false);
        setShowAdvancedEndpoint(false);
    }

    function selectModel(id: string) {
        onChange("model", id);
        setOpen(false);
        setSearch("");
    }

    function handleModelKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActiveOptionIndex((index) =>
                filteredModels.length === 0 ? 0 : Math.min(index + 1, filteredModels.length - 1),
            );
            return;
        }

        if (e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActiveOptionIndex((index) => Math.max(index - 1, 0));
            return;
        }

        if (e.key === "Enter" && open && activeOption) {
            e.preventDefault();
            selectModel(activeOption.id);
            return;
        }

        if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            setSearch("");
        }
    }

    return (
        <div className="ai-panel">
            {/* Provider grid */}
            <div className="ai-row ai-row--col">
                <label htmlFor={providerId} className="ai-row-label">
                    Provider
                    <span className="ai-row-hint">
                        Pick the AI service Raiken should call. DeepSeek and custom endpoints use
                        the OpenAI-compatible path.
                    </span>
                </label>
                <div className="ai-provider-grid">
                    {providers.map((p) => {
                        const active = p.id === activeProviderId;
                        return (
                            <button
                                key={p.id}
                                type="button"
                                aria-pressed={active}
                                className={`ai-provider-card ${active ? "active" : ""}`}
                                onClick={() => handleProviderChange(p.id)}
                            >
                                <span className="ai-provider-card-head">
                                    <span className="ai-provider-card-name">{p.label}</span>
                                    {p.hasKey && (
                                        <span
                                            className="ai-provider-card-tag"
                                            title="API key detected in env"
                                        >
                                            key set
                                        </span>
                                    )}
                                </span>
                                <span className="ai-provider-card-desc">{p.description}</span>
                                {p.envVars.length > 0 && (
                                    <span className="ai-provider-card-env">
                                        env: <code>{p.envVars[0]}</code>
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* API key */}
            <div className="ai-row ai-row--col">
                <label htmlFor={apiKeyId} className="ai-row-label">
                    API key
                    <span className="ai-row-hint">
                        Stored locally in <code>raiken.config.json</code>
                        {activeProvider?.envVars[0] && (
                            <>
                                {" "}
                                or set <code>{activeProvider.envVars[0]}</code> in your{" "}
                                <code>.env</code>.
                            </>
                        )}
                        {activeProvider?.apiKeyUrl && (
                            <>
                                {" — "}
                                <a
                                    href={activeProvider.apiKeyUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="ai-link"
                                >
                                    get a key →
                                </a>
                            </>
                        )}
                    </span>
                </label>
                <input
                    id={apiKeyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey ?? ""}
                    onChange={(e) => onChange("apiKey", e.target.value)}
                    placeholder={activeProvider?.apiKeyPlaceholder ?? "sk-…"}
                    className="ai-input"
                />
            </div>

            {/* Model combobox */}
            <div className="ai-row ai-row--col">
                <label htmlFor={modelId} className="ai-row-label">
                    Model
                    <span className="ai-row-hint">
                        {isFetchingModels && "Loading models…"}
                        {!isFetchingModels && modelsError && (
                            <>
                                Couldn't load model list from {activeProvider?.label}: {modelsError}
                                . You can still type a model ID below.
                            </>
                        )}
                        {!isFetchingModels &&
                            !modelsError &&
                            allModels.length > 0 &&
                            `${allModels.length} model${allModels.length === 1 ? "" : "s"} available from ${activeProvider?.label}. Recommended models are shown when live discovery is unavailable.`}
                        {!isFetchingModels &&
                            !modelsError &&
                            allModels.length === 0 &&
                            !canFetchModels &&
                            "Enter an API key to load the live model catalog, or type a model ID."}
                    </span>
                </label>

                <div className="ai-combobox" ref={wrapperRef}>
                    <input
                        id={modelId}
                        type="text"
                        value={open ? search : (model ?? "")}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setOpen(true);
                            // free-form: user can type arbitrary model id
                            onChange("model", e.target.value);
                        }}
                        onFocus={() => {
                            setSearch(model ?? "");
                            setOpen(true);
                        }}
                        onKeyDown={handleModelKeyDown}
                        placeholder={activeProvider?.defaultModel || "model-id"}
                        className="ai-input"
                        role="combobox"
                        aria-expanded={open}
                        aria-controls={listboxId}
                        aria-activedescendant={
                            open && activeOption
                                ? optionDomId(listboxId, activeOption.id)
                                : undefined
                        }
                        aria-autocomplete="list"
                    />
                    <button
                        type="button"
                        className="ai-combobox-toggle"
                        onClick={() => {
                            setSearch("");
                            setOpen((v) => !v);
                        }}
                        aria-label="Toggle model list"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            aria-hidden="true"
                        >
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                    </button>

                    {open && (
                        <div className="ai-combobox-pop" role="listbox" id={listboxId}>
                            {isFetchingModels && <div className="ai-combobox-empty">Loading…</div>}
                            {!isFetchingModels && modelsHaveResults && (
                                <ul className="ai-combobox-list">
                                    {filteredModels.slice(0, 200).map((m) => (
                                        <li key={m.id}>
                                            <button
                                                id={optionDomId(listboxId, m.id)}
                                                type="button"
                                                role="option"
                                                aria-selected={m.id === model}
                                                className={`ai-combobox-option ${m.id === model ? "selected" : ""}`}
                                                onClick={() => selectModel(m.id)}
                                            >
                                                <span className="ai-combobox-option-id">
                                                    {m.id}
                                                </span>
                                                {m.name && m.name !== m.id && (
                                                    <span className="ai-combobox-option-name">
                                                        {m.name}
                                                    </span>
                                                )}
                                                {(m.context || m.description) && (
                                                    <span className="ai-combobox-option-meta">
                                                        {m.context
                                                            ? `${(m.context / 1000).toFixed(0)}k ctx`
                                                            : ""}
                                                        {m.context && m.description ? " · " : ""}
                                                        {m.description?.slice(0, 80)}
                                                    </span>
                                                )}
                                                {m.source === "recommended" && (
                                                    <span className="ai-combobox-option-source">
                                                        recommended
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    ))}
                                    {filteredModels.length > 200 && (
                                        <li className="ai-combobox-truncated">
                                            …and {filteredModels.length - 200} more. Type to filter.
                                        </li>
                                    )}
                                </ul>
                            )}
                            {!isFetchingModels && !modelsHaveResults && (
                                <div className="ai-combobox-empty">
                                    {allModels.length === 0
                                        ? "No models loaded. Type a model ID above."
                                        : `No matches for "${search}".`}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Optional base URL */}
            {!showBaseUrl && (
                <button
                    type="button"
                    className="ai-advanced-toggle"
                    onClick={() => setShowAdvancedEndpoint(true)}
                >
                    Override provider endpoint
                </button>
            )}
            {showBaseUrl && (
                <div className="ai-row ai-row--col">
                    <label htmlFor={baseUrlId} className="ai-row-label">
                        Base URL
                        <span className="ai-row-hint">
                            Provider endpoint. Use this for OpenAI-compatible providers such as
                            DeepSeek-compatible proxies, local Ollama, or custom gateways.
                        </span>
                    </label>
                    <input
                        id={baseUrlId}
                        type="text"
                        value={baseURL ?? ""}
                        onChange={(e) => onChange("baseURL", e.target.value)}
                        placeholder={activeProvider?.defaultBaseURL || "https://…/v1"}
                        className="ai-input"
                    />
                </div>
            )}

            <style>{`
                .ai-panel {
                    display: flex;
                    flex-direction: column;
                    gap: 1.25rem;
                }
                .ai-row {
                    display: flex;
                    gap: 1.25rem;
                    align-items: flex-start;
                }
                .ai-row--col { flex-direction: column; align-items: stretch; gap: 0.5rem; }
                .ai-row-label {
                    display: flex;
                    flex-direction: column;
                    gap: 0.125rem;
                    font-size: 12.5px;
                    font-weight: 500;
                    color: var(--ink);
                    font-family: var(--mono);
                }
                .ai-row-hint {
                    font-size: 11px;
                    font-weight: 400;
                    color: var(--ink-faint);
                    line-height: 1.5;
                }
                .ai-row-hint code {
                    font-size: 10.5px;
                    background: var(--bg-bar);
                    padding: 1px 4px;
                    color: var(--ink-dim);
                }
                .ai-link {
                    color: var(--accent);
                    text-decoration: none;
                    border-bottom: 1px dotted var(--accent-dim);
                }
                .ai-link:hover { color: var(--accent-strong); }
                .ai-advanced-toggle {
                    align-self: flex-start;
                    background: transparent;
                    border: 0;
                    padding: 0;
                    color: var(--accent);
                    font-family: var(--mono);
                    font-size: 11px;
                    cursor: pointer;
                    border-bottom: 1px dotted var(--accent-dim);
                }
                .ai-advanced-toggle:hover { color: var(--accent-strong); }
                .ai-input {
                    width: 100%;
                    padding: 0.5rem 0.625rem;
                    background: var(--bg);
                    border: 1px solid var(--hair-strong);
                    color: var(--ink);
                    font-family: var(--mono);
                    font-size: 12px;
                    outline: none;
                    transition: border-color 0.12s;
                    box-sizing: border-box;
                }
                .ai-input:focus { border-color: var(--accent); }

                .ai-provider-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                    gap: 0.5rem;
                }
                .ai-provider-card {
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    padding: 0.625rem 0.75rem;
                    background: var(--bg);
                    border: 1px solid var(--hair-strong);
                    color: var(--ink-dim);
                    text-align: left;
                    cursor: pointer;
                    font-family: var(--mono);
                    transition: border-color 0.12s, background 0.12s, color 0.12s;
                }
                .ai-provider-card:hover {
                    background: var(--bg-hover);
                    color: var(--ink);
                }
                .ai-provider-card.active {
                    border-color: var(--accent);
                    background: var(--accent-soft);
                    color: var(--accent);
                }
                .ai-provider-card-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 0.5rem;
                }
                .ai-provider-card-name {
                    font-size: 12.5px;
                    font-weight: 500;
                    color: var(--ink);
                }
                .ai-provider-card.active .ai-provider-card-name { color: var(--accent); }
                .ai-provider-card-tag {
                    font-size: 9.5px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    padding: 1px 4px;
                    background: var(--pass-soft);
                    color: var(--pass);
                    border: 1px solid rgba(111, 184, 111, 0.3);
                }
                .ai-provider-card-desc {
                    font-size: 11px;
                    color: var(--ink-faint);
                    line-height: 1.4;
                }
                .ai-provider-card-env {
                    margin-top: auto;
                    font-size: 10.5px;
                    color: var(--ink-faint);
                }
                .ai-provider-card-env code {
                    background: var(--bg-bar);
                    padding: 1px 4px;
                    color: var(--ink-dim);
                }

                .ai-combobox {
                    position: relative;
                }
                .ai-combobox-toggle {
                    position: absolute;
                    right: 0.25rem;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 22px;
                    height: 22px;
                    background: transparent;
                    border: 0;
                    color: var(--ink-faint);
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }
                .ai-combobox-toggle:hover { color: var(--ink); }
                .ai-combobox-toggle svg { width: 14px; height: 14px; }

                .ai-combobox-pop {
                    position: absolute;
                    top: calc(100% + 4px);
                    left: 0;
                    right: 0;
                    z-index: 30;
                    background: var(--bg-bar);
                    border: 1px solid var(--hair-strong);
                    max-height: 320px;
                    overflow: auto;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
                }
                .ai-combobox-list {
                    list-style: none;
                    margin: 0;
                    padding: 0;
                }
                .ai-combobox-option {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 1px;
                    padding: 0.4375rem 0.625rem;
                    background: transparent;
                    border: 0;
                    border-bottom: 1px solid var(--hair);
                    text-align: left;
                    cursor: pointer;
                    font-family: var(--mono);
                    color: var(--ink);
                }
                .ai-combobox-option:hover { background: var(--bg-hover); }
                .ai-combobox-option.selected {
                    background: var(--accent-soft);
                    color: var(--accent);
                }
                .ai-combobox-option-id {
                    font-size: 12px;
                    font-weight: 500;
                }
                .ai-combobox-option-name {
                    font-size: 11px;
                    color: var(--ink-faint);
                }
                .ai-combobox-option.selected .ai-combobox-option-name { color: var(--accent-strong); }
                .ai-combobox-option-meta {
                    font-size: 10.5px;
                    color: var(--ink-faint);
                }
                .ai-combobox-option-source {
                    align-self: flex-start;
                    margin-top: 2px;
                    font-size: 9.5px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--ink-faint);
                    border: 1px solid var(--hair-strong);
                    padding: 1px 4px;
                }
                .ai-combobox-empty,
                .ai-combobox-truncated {
                    padding: 0.625rem 0.75rem;
                    font-size: 11px;
                    color: var(--ink-faint);
                    font-family: var(--mono);
                    text-align: center;
                    list-style: none;
                }
            `}</style>
        </div>
    );
}
