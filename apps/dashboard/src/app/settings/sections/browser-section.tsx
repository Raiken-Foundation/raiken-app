import { defaultConfig } from "@raiken/shared";
import { FieldGroup, ToggleSwitch } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";
import { optionalNumber } from "../utils";

type BrowserSectionProps = Pick<SettingsFormApi, "val" | "update">;

export function BrowserSection({ val, update }: BrowserSectionProps) {
    return (
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
                    onChange={(e) => update("browser", "defaultBrowser", e.target.value)}
                >
                    <option value="chromium">Chromium</option>
                    <option value="firefox">Firefox</option>
                    <option value="webkit">WebKit</option>
                </select>
            </FieldGroup>
            <FieldGroup label="Headless" hint="Run tests without a visible browser window.">
                <ToggleSwitch
                    checked={
                        (val("browser", "headless") as boolean) ?? defaultConfig.browser.headless
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
                    value={(val("browser", "timeout") as number) ?? defaultConfig.browser.timeout}
                    onChange={(e) => update("browser", "timeout", optionalNumber(e.target.value))}
                />
            </FieldGroup>
            <FieldGroup label="Retries" hint="Number of times to retry a failed test.">
                <input
                    type="number"
                    min={0}
                    max={5}
                    value={(val("browser", "retries") as number) ?? defaultConfig.browser.retries}
                    onChange={(e) => update("browser", "retries", optionalNumber(e.target.value))}
                />
            </FieldGroup>
        </>
    );
}
