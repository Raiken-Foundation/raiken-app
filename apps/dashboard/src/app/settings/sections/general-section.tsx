import { defaultConfig } from "@raiken/shared";
import { FieldGroup } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";

type GeneralSectionProps = Pick<SettingsFormApi, "form" | "updateTop">;

export function GeneralSection({ form, updateTop }: GeneralSectionProps) {
    return (
        <>
            <FieldGroup
                label="Test Directory"
                hint="Where generated tests are saved, relative to the project root."
            >
                <input
                    type="text"
                    value={(form.testDirectory as string) ?? defaultConfig.testDirectory}
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
                    value={(form.playwrightConfig as string) ?? defaultConfig.playwrightConfig}
                    onChange={(e) => updateTop("playwrightConfig", e.target.value)}
                    placeholder={defaultConfig.playwrightConfig}
                />
            </FieldGroup>
            <FieldGroup label="Project Type" hint="Type of project (generic, react, nextjs, etc.)">
                <input
                    type="text"
                    value={(form.projectType as string) ?? defaultConfig.projectType}
                    onChange={(e) => updateTop("projectType", e.target.value)}
                    placeholder={defaultConfig.projectType}
                />
            </FieldGroup>
        </>
    );
}
