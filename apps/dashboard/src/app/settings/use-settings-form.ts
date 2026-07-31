import type { PublicRaikenConfig } from "@raiken/shared";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { EMPTY_SECRET_DRAFTS } from "./constants";
import type { SettingsFormApi, SettingsFormState } from "./types";
import {
    patchAtPath,
    patchSectionField,
    readDefault,
    readPath,
    readSectionField,
    resolveActiveAiProvider,
} from "./utils";

type FormAction =
    | { type: "sync"; config: Partial<PublicRaikenConfig> }
    | {
          type: "update";
          section: keyof PublicRaikenConfig;
          field: string;
          value: unknown;
      }
    | { type: "updateTop"; field: keyof PublicRaikenConfig; value: unknown }
    | { type: "updateAt"; path: string[]; value: unknown }
    | { type: "updateAiKeyDraft"; provider: string; value: string }
    | { type: "updateLinearApiKey"; value: string }
    | { type: "reset"; config: Partial<PublicRaikenConfig> }
    | { type: "markSaved" };

function formReducer(state: SettingsFormState, action: FormAction): SettingsFormState {
    switch (action.type) {
        case "sync":
            if (state.dirty) return state;
            return {
                form: action.config,
                secretDrafts: { aiKeys: {}, linearApiKey: "" },
                dirty: false,
            };
        case "update":
            return {
                ...state,
                form: patchSectionField(state.form, action.section, action.field, action.value),
                dirty: true,
            };
        case "updateTop":
            return {
                ...state,
                form: { ...state.form, [action.field]: action.value },
                dirty: true,
            };
        case "updateAt":
            return {
                ...state,
                form: patchAtPath(state.form, action.path, action.value),
                dirty: true,
            };
        case "updateAiKeyDraft":
            return {
                ...state,
                secretDrafts: {
                    ...state.secretDrafts,
                    aiKeys: {
                        ...state.secretDrafts.aiKeys,
                        [action.provider]: action.value,
                    },
                },
                dirty: true,
            };
        case "updateLinearApiKey":
            return {
                ...state,
                secretDrafts: {
                    ...state.secretDrafts,
                    linearApiKey: action.value,
                },
                dirty: true,
            };
        case "reset":
            return {
                form: action.config,
                secretDrafts: { aiKeys: {}, linearApiKey: "" },
                dirty: false,
            };
        case "markSaved":
            return {
                ...state,
                dirty: false,
                secretDrafts: { aiKeys: {}, linearApiKey: "" },
            };
        default:
            return state;
    }
}

const initialState: SettingsFormState = {
    form: {},
    secretDrafts: { ...EMPTY_SECRET_DRAFTS },
    dirty: false,
};

export function createInitialFormState(config?: Partial<PublicRaikenConfig>): SettingsFormState {
    return {
        form: config ?? {},
        secretDrafts: { aiKeys: {}, linearApiKey: "" },
        dirty: false,
    };
}

export function reduceSettingsForm(
    state: SettingsFormState,
    action: FormAction,
): SettingsFormState {
    return formReducer(state, action);
}

export function useSettingsForm(authoritativeConfig: Partial<PublicRaikenConfig> | undefined) {
    const [state, dispatch] = useReducer(formReducer, initialState);

    useEffect(() => {
        if (authoritativeConfig && !state.dirty) {
            dispatch({ type: "sync", config: authoritativeConfig });
        }
    }, [authoritativeConfig, state.dirty]);

    const activeAiProvider = useMemo(() => resolveActiveAiProvider(state.form), [state.form]);

    const val = useCallback(
        <K extends keyof PublicRaikenConfig>(section: K, field: string) =>
            readSectionField(state.form, section, field),
        [state.form],
    );

    const valAt = useCallback((path: string[]) => readPath(state.form, path), [state.form]);

    const def = useCallback(
        <K extends Parameters<typeof readDefault>[0]>(section: K, field: string) =>
            readDefault(section, field),
        [],
    );

    const update = useCallback(
        <K extends keyof PublicRaikenConfig>(section: K, field: string, value: unknown) => {
            dispatch({ type: "update", section, field, value });
        },
        [],
    );

    const updateTop = useCallback((field: keyof PublicRaikenConfig, value: unknown) => {
        dispatch({ type: "updateTop", field, value });
    }, []);

    const updateAt = useCallback((path: string[], value: unknown) => {
        dispatch({ type: "updateAt", path, value });
    }, []);

    const updateAiKeyDraft = useCallback(
        (value: string) => {
            dispatch({ type: "updateAiKeyDraft", provider: activeAiProvider, value });
        },
        [activeAiProvider],
    );

    const updateLinearApiKey = useCallback((value: string) => {
        dispatch({ type: "updateLinearApiKey", value });
    }, []);

    const reset = useCallback((config: Partial<PublicRaikenConfig>) => {
        dispatch({ type: "reset", config });
    }, []);

    const markSaved = useCallback(() => {
        dispatch({ type: "markSaved" });
    }, []);

    const api: SettingsFormApi = useMemo(
        () => ({
            form: state.form,
            secretDrafts: state.secretDrafts,
            dirty: state.dirty,
            activeAiProvider,
            val,
            valAt,
            def,
            update,
            updateTop,
            updateAt,
            updateAiKeyDraft,
            updateLinearApiKey,
            reset,
        }),
        [
            state.form,
            state.secretDrafts,
            state.dirty,
            activeAiProvider,
            val,
            valAt,
            def,
            update,
            updateTop,
            updateAt,
            updateAiKeyDraft,
            updateLinearApiKey,
            reset,
        ],
    );

    return { ...api, markSaved };
}

export type SettingsFormAction = FormAction;
