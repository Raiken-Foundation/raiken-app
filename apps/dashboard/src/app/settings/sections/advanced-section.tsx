import { FieldGroup, ToggleSwitch } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";
import { optionalNumber } from "../utils";

type AdvancedSectionProps = Pick<SettingsFormApi, "val" | "def" | "update">;

export function AdvancedSection({ val, def, update }: AdvancedSectionProps) {
    return (
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
                        update("discovery", "maxRunTimeMs", optionalNumber(e.target.value))
                    }
                />
            </FieldGroup>
            <FieldGroup
                label="Preserve Query Params"
                hint="Treat URLs that differ only by query string as distinct routes, instead of collapsing them."
            >
                <ToggleSwitch
                    checked={(val("discovery", "preserveQueryParams") as boolean) ?? false}
                    onChange={(v) => update("discovery", "preserveQueryParams", v)}
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
    );
}
