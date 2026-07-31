import { useState } from "react";
import { Header } from "../../components/header";
import { trpc } from "../../utils/trpc";
import { SECTION_DESCRIPTIONS, SECTIONS } from "./constants";
import { SaveBar, SaveErrorBanner } from "./save-status";
import { SettingsNav } from "./settings-nav";
import { SettingsSectionContent } from "./settings-section-content";
import { SettingsErrorState, SettingsLoadingState } from "./settings-states";
import type { Section } from "./types";
import { useSettingsForm } from "./use-settings-form";
import { useSettingsSave } from "./use-settings-save";
import "./settings.css";

export function SettingsView() {
    const [activeSection, setActiveSection] = useState<Section>("general");

    const configQuery = trpc.getConfig.useQuery();
    const formApi = useSettingsForm(configQuery.data?.config);
    const save = useSettingsSave(formApi, configQuery.data?.config);

    if (configQuery.isLoading) {
        return (
            <div className="settings-view">
                <Header projectName="Settings" />
                <SettingsLoadingState />
            </div>
        );
    }

    if (configQuery.isError) {
        return (
            <div className="settings-view">
                <Header projectName="Settings" />
                <SettingsErrorState
                    message={configQuery.error?.message ?? "Unknown error"}
                    onRetry={() => configQuery.refetch()}
                />
            </div>
        );
    }

    const activeLabel = SECTIONS.find((s) => s.id === activeSection)?.label;

    return (
        <div className="settings-view">
            <Header projectName="Settings" />

            <div className="settings-body">
                <SettingsNav activeSection={activeSection} onSelect={setActiveSection} />

                <main className="settings-main">
                    <div className="settings-header">
                        <div>
                            <h1>{activeLabel}</h1>
                            <p className="settings-desc">{SECTION_DESCRIPTIONS[activeSection]}</p>
                        </div>
                        <SaveBar
                            dirty={formApi.dirty}
                            saved={save.saved}
                            isSaving={save.isSaving}
                            onDiscard={save.handleReset}
                            onSave={save.handleSave}
                        />
                    </div>

                    {save.saveError && (
                        <SaveErrorBanner error={save.saveError} onDismiss={save.dismissSaveError} />
                    )}

                    <div className="field-list">
                        <SettingsSectionContent section={activeSection} formApi={formApi} />
                    </div>
                </main>
            </div>
        </div>
    );
}

export default SettingsView;
