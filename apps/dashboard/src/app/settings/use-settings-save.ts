import type { PublicRaikenConfig } from "@raiken/shared";
import { createSettingsConfigPatch, formatTrpcClientErrorMessage } from "@raiken/shared";
import { useCallback, useEffect, useState } from "react";
import { trpc } from "../../utils/trpc";
import type { SettingsFormApi } from "./types";

export function formatSaveValidationError(errors?: string[]): string {
    return errors?.length
        ? `Invalid configuration — ${errors.join("; ")}`
        : "Invalid configuration.";
}

export function parseSaveResponse(data: unknown): { ok: true } | { ok: false; error: string } {
    const res = data as { success: boolean; errors?: string[] };
    if (res && res.success === false) {
        return { ok: false, error: formatSaveValidationError(res.errors) };
    }
    return { ok: true };
}

export function useSettingsSave(
    formApi: SettingsFormApi & { markSaved: () => void },
    authoritativeConfig: Partial<PublicRaikenConfig> | undefined,
) {
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const configQuery = trpc.getConfig.useQuery();
    const saveMutation = trpc.updateConfig.useMutation({
        onSuccess: (data) => {
            const result = parseSaveResponse(data);
            if (!result.ok) {
                setSaveError(result.error);
                return;
            }
            formApi.markSaved();
            setSaved(true);
            setSaveError(null);
            configQuery.refetch();
            setTimeout(() => setSaved(false), 2000);
        },
        onError: (error) => {
            setSaveError(formatTrpcClientErrorMessage(error) || "Failed to save configuration");
        },
    });

    useEffect(() => {
        if (formApi.dirty) {
            setSaved(false);
        }
    }, [formApi.dirty]);

    const handleSave = useCallback(() => {
        saveMutation.mutate({
            config: createSettingsConfigPatch(formApi.form, formApi.secretDrafts),
        });
    }, [formApi.form, formApi.secretDrafts, saveMutation]);

    const handleReset = useCallback(() => {
        formApi.reset(authoritativeConfig ?? {});
        setSaveError(null);
    }, [authoritativeConfig, formApi]);

    const dismissSaveError = useCallback(() => {
        setSaveError(null);
    }, []);

    return {
        saved,
        saveError,
        isSaving: saveMutation.isPending,
        handleSave,
        handleReset,
        dismissSaveError,
    };
}
