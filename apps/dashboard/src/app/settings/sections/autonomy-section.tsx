import { FieldGroup, ToggleSwitch } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";
import { optionalNumber } from "../utils";

type AutonomySectionProps = Pick<SettingsFormApi, "val" | "update">;

export function AutonomySection({ val, update }: AutonomySectionProps) {
    return (
        <>
            <FieldGroup
                label="Auto-save Tests"
                hint="Save generated tests without asking for confirmation."
            >
                <ToggleSwitch
                    checked={(val("autonomy", "autoSaveTests") as boolean) ?? false}
                    onChange={(v) => update("autonomy", "autoSaveTests", v)}
                />
            </FieldGroup>
            <FieldGroup
                label="Auto-run Tests"
                hint="Automatically run tests after generating them."
            >
                <ToggleSwitch
                    checked={(val("autonomy", "autoRunTests") as boolean) ?? false}
                    onChange={(v) => update("autonomy", "autoRunTests", v)}
                />
            </FieldGroup>
            <FieldGroup
                label="Auto-correct Behavior"
                hint="How Raiken handles test failures: suggest a diff, auto-apply fixes, or do nothing."
            >
                <select
                    value={(val("autonomy", "autoCorrect") as string) ?? "suggest"}
                    onChange={(e) => update("autonomy", "autoCorrect", e.target.value)}
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
                    value={(val("autonomy", "autoLearn") as string) ?? "confirm"}
                    onChange={(e) => update("autonomy", "autoLearn", e.target.value)}
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
                        update("autonomy", "maxRetries", optionalNumber(e.target.value))
                    }
                />
            </FieldGroup>
        </>
    );
}
