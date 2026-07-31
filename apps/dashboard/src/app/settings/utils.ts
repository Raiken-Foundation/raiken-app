import type { PublicRaikenConfig, RaikenConfig } from "@raiken/shared";
import { defaultConfig } from "@raiken/shared";

export function optionalNumber(value: string): number | undefined {
    if (value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function readSectionField(
    form: Partial<PublicRaikenConfig>,
    section: keyof PublicRaikenConfig,
    field: string,
): unknown {
    const s = form[section];
    if (s && typeof s === "object") {
        return (s as Record<string, unknown>)[field];
    }
    return undefined;
}

export function readPath(form: Partial<PublicRaikenConfig>, path: string[]): unknown {
    let obj: unknown = form;
    for (const key of path) {
        if (obj && typeof obj === "object") {
            obj = (obj as Record<string, unknown>)[key];
        } else {
            return undefined;
        }
    }
    return obj;
}

export function readDefault<K extends keyof RaikenConfig>(section: K, field: string): unknown {
    const s = defaultConfig[section];
    if (s && typeof s === "object") {
        return (s as Record<string, unknown>)[field];
    }
    return undefined;
}

export function patchSectionField(
    prev: Partial<PublicRaikenConfig>,
    section: keyof PublicRaikenConfig,
    field: string,
    value: unknown,
): Partial<PublicRaikenConfig> {
    return {
        ...prev,
        [section]:
            typeof prev[section] === "object" && prev[section] !== null
                ? { ...(prev[section] as Record<string, unknown>), [field]: value }
                : { [field]: value },
    };
}

export function patchAtPath(
    prev: Partial<PublicRaikenConfig>,
    path: string[],
    value: unknown,
): Partial<PublicRaikenConfig> {
    const next = structuredClone(prev) as Record<string, unknown>;
    let obj = next;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (typeof obj[key] !== "object" || obj[key] === null) {
            obj[key] = {};
        }
        obj = obj[key] as Record<string, unknown>;
    }
    obj[path[path.length - 1]] = value;
    return next as Partial<PublicRaikenConfig>;
}

export function resolveActiveAiProvider(form: Partial<PublicRaikenConfig>): string {
    return (
        (readSectionField(form, "ai", "provider") as string | undefined) ??
        defaultConfig.ai.provider
    );
}
