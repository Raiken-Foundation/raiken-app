import { AIProviderPanel } from "../../../components/ai-provider-panel";
import { FieldGroup } from "../fields/field-controls";
import type { SettingsFormApi } from "../types";
import { optionalNumber } from "../utils";

type AiSectionProps = Pick<
    SettingsFormApi,
    "val" | "def" | "update" | "activeAiProvider" | "secretDrafts" | "updateAiKeyDraft"
>;

export function AiSection({
    val,
    def,
    update,
    activeAiProvider,
    secretDrafts,
    updateAiKeyDraft,
}: AiSectionProps) {
    return (
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
                    value={(val("ai", "maxTokens") as number) ?? (def("ai", "maxTokens") as number)}
                    onChange={(e) => update("ai", "maxTokens", optionalNumber(e.target.value))}
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
                        (val("ai", "temperature") as number) ?? (def("ai", "temperature") as number)
                    }
                    onChange={(e) => update("ai", "temperature", optionalNumber(e.target.value))}
                />
            </FieldGroup>
        </>
    );
}
