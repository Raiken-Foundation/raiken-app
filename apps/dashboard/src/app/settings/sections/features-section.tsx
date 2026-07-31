import { defaultConfig } from "@raiken/shared";
import { FieldGroup, ToggleSwitch } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";

type FeaturesSectionProps = Pick<SettingsFormApi, "val" | "update">;

export function FeaturesSection({ val, update }: FeaturesSectionProps) {
    return (
        <>
            <FieldGroup label="Video Recording" hint="Record video of test runs for debugging.">
                <ToggleSwitch
                    checked={(val("features", "video") as boolean) ?? defaultConfig.features.video}
                    onChange={(v) => update("features", "video", v)}
                />
            </FieldGroup>
            <FieldGroup label="Screenshots" hint="Capture screenshots on test failure.">
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
                        (val("features", "tracing") as boolean) ?? defaultConfig.features.tracing
                    }
                    onChange={(v) => update("features", "tracing", v)}
                />
            </FieldGroup>
            <FieldGroup label="Network Logging" hint="Capture network requests during test runs.">
                <ToggleSwitch
                    checked={
                        (val("features", "network") as boolean) ?? defaultConfig.features.network
                    }
                    onChange={(v) => update("features", "network", v)}
                />
            </FieldGroup>
        </>
    );
}
