import type { PublicRaikenConfig, RaikenConfig, SecretDrafts } from "@raiken/shared";

export type Section =
    | "general"
    | "ai"
    | "auth"
    | "browser"
    | "discovery"
    | "advanced"
    | "features"
    | "autonomy"
    | "integrations";

export interface SettingsFormState {
    form: Partial<PublicRaikenConfig>;
    secretDrafts: SecretDrafts;
    dirty: boolean;
}

export interface SettingsFormApi {
    form: Partial<PublicRaikenConfig>;
    secretDrafts: SecretDrafts;
    dirty: boolean;
    activeAiProvider: string;
    val: <K extends keyof PublicRaikenConfig>(section: K, field: string) => unknown;
    valAt: (path: string[]) => unknown;
    def: <K extends keyof RaikenConfig>(section: K, field: string) => unknown;
    update: <K extends keyof PublicRaikenConfig>(section: K, field: string, value: unknown) => void;
    updateTop: (field: keyof PublicRaikenConfig, value: unknown) => void;
    updateAt: (path: string[], value: unknown) => void;
    updateAiKeyDraft: (value: string) => void;
    updateLinearApiKey: (value: string) => void;
    reset: (config: Partial<PublicRaikenConfig>) => void;
}
