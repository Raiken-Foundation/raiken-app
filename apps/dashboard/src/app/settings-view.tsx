import { useEffect, useState } from "react";
import { AIProviderPanel } from "../components/ai-provider-panel";
import { Header } from "../components/header";
import { trpc } from "../utils/trpc";

interface RaikenConfig {
    projectType: string;
    testDirectory: string;
    playwrightConfig: string;
    outputFormats: string[];
    ai: { provider: string; model: string; apiKey?: string; baseURL?: string };
    auth?: Record<string, unknown>;
    features: { video: boolean; screenshots: boolean; tracing: boolean; network: boolean };
    indexing?: { fullScan: boolean };
    discovery?: {
        maxPages?: number;
        maxDepth?: number;
        maxConcurrency?: number;
        timeout?: number;
        excludePatterns?: string[];
        pauseOnAuth?: boolean;
    };
    browser: { defaultBrowser: string; headless: boolean; timeout: number; retries: number };
    autonomy?: {
        autoSaveTests: boolean;
        autoRunTests: boolean;
        autoCorrect: "suggest" | "apply" | "off";
        autoLearn: string;
        maxRetries: number;
    };
}

const defaultConfig: RaikenConfig = {
    projectType: "generic",
    testDirectory: "e2e",
    playwrightConfig: "playwright.config.ts",
    outputFormats: ["typescript"],
    ai: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
    features: { video: true, screenshots: true, tracing: false, network: true },
    discovery: {
        maxPages: 100,
        maxDepth: 5,
        maxConcurrency: 3,
        timeout: 30000,
        excludePatterns: [],
        pauseOnAuth: true,
    },
    browser: { defaultBrowser: "chromium", headless: true, timeout: 30000, retries: 1 },
    autonomy: {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
        maxRetries: 2,
    },
};

type Section = "general" | "ai" | "browser" | "discovery" | "features" | "autonomy";

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
];

export function SettingsView() {
    const [activeSection, setActiveSection] = useState<Section>("general");
    const [form, setForm] = useState<Partial<RaikenConfig>>({});
    const [dirty, setDirty] = useState(false);
    const [saved, setSaved] = useState(false);

    const [saveError, setSaveError] = useState<string | null>(null);

    const configQuery = trpc.getConfig.useQuery();
    const saveMutation = trpc.updateConfig.useMutation({
        onSuccess: () => {
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
        if (configQuery.data) {
            setForm(configQuery.data as Partial<RaikenConfig>);
        }
    }, [configQuery.data]);

    const update = <K extends keyof RaikenConfig>(section: K, field: string, value: unknown) => {
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

    const updateTop = (field: keyof RaikenConfig, value: unknown) => {
        setForm((prev) => ({ ...prev, [field]: value }));
        setDirty(true);
        setSaved(false);
    };

    const handleSave = () => {
        saveMutation.mutate({ config: form as Record<string, unknown> });
    };

    const handleReset = () => {
        setForm(configQuery.data as Partial<RaikenConfig>);
        setDirty(false);
    };

    const val = <K extends keyof RaikenConfig>(section: K, field: string): unknown => {
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
                <nav className="settings-nav" role="navigation" aria-label="Settings sections">
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
                                {activeSection === "browser" &&
                                    "Browser settings for running Playwright tests."}
                                {activeSection === "discovery" &&
                                    "Control how Raiken crawls and discovers your site structure."}
                                {activeSection === "features" &&
                                    "Toggle test recording features and artifacts."}
                                {activeSection === "autonomy" &&
                                    "Control how much Raiken does automatically vs. asking for confirmation."}
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
                            <AIProviderPanel
                                provider={val("ai", "provider") as string | undefined}
                                apiKey={val("ai", "apiKey") as string | undefined}
                                model={val("ai", "model") as string | undefined}
                                baseURL={val("ai", "baseURL") as string | undefined}
                                onChange={(field, value) => update("ai", field, value)}
                            />
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
                                            update("browser", "timeout", Number(e.target.value))
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
                                            update("browser", "retries", Number(e.target.value))
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
                                            update("discovery", "maxPages", Number(e.target.value))
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
                                            update("discovery", "maxDepth", Number(e.target.value))
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
                                                Number(e.target.value),
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
                                            update("discovery", "timeout", Number(e.target.value))
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
                                            update("autonomy", "maxRetries", Number(e.target.value))
                                        }
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
                .field-control select {
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

                .field-control input:focus,
                .field-control select:focus {
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
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="field-group">
            <div className="field-label-block">
                <div className="field-label">{label}</div>
                {hint && <p className="field-hint">{hint}</p>}
            </div>
            <div className="field-control">{children}</div>
        </div>
    );
}

function ToggleSwitch({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <button
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
