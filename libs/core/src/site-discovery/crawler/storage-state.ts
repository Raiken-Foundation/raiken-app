import * as fs from "node:fs";
import { describeAuthStateProblem, inspectAuthState } from "../../config/auth-state";
import type { PlaywrightStorageState, StorageStateCookie, StorageStateInput } from "./types";

/**
 * Coerce raw storage-state JSON into the exact shape Playwright accepts at
 * `browser.newContext({ storageState })`. Real-world auth-state.json files
 * — especially those produced by older Chromium versions or third-party
 * exporters — frequently contain cookies with `sameSite: null` or non-
 * canonical values, which Playwright rejects, silently dropping the entire
 * session. Coerce to "Lax" as a safe default and strip unknown fields.
 */
export function sanitizeStorageState(state: StorageStateInput): PlaywrightStorageState {
    const validSameSite = new Set(["Strict", "Lax", "None"]);
    const cookies: StorageStateCookie[] = [];
    for (const raw of Array.isArray(state.cookies) ? state.cookies : []) {
        if (
            typeof raw !== "object" ||
            raw === null ||
            typeof (raw as Record<string, unknown>)["name"] !== "string" ||
            typeof (raw as Record<string, unknown>)["value"] !== "string"
        ) {
            continue;
        }
        const r = raw as Record<string, unknown>;
        const sameSiteRaw = r["sameSite"];
        const sameSite: "Strict" | "Lax" | "None" =
            typeof sameSiteRaw === "string" && validSameSite.has(sameSiteRaw)
                ? (sameSiteRaw as "Strict" | "Lax" | "None")
                : "Lax";
        cookies.push({
            name: r["name"] as string,
            value: r["value"] as string,
            domain: typeof r["domain"] === "string" ? (r["domain"] as string) : undefined,
            path: typeof r["path"] === "string" ? (r["path"] as string) : undefined,
            url: typeof r["url"] === "string" ? (r["url"] as string) : undefined,
            expires: typeof r["expires"] === "number" ? (r["expires"] as number) : undefined,
            httpOnly: typeof r["httpOnly"] === "boolean" ? (r["httpOnly"] as boolean) : undefined,
            secure: typeof r["secure"] === "boolean" ? (r["secure"] as boolean) : undefined,
            sameSite,
        });
    }

    const origins: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
    }> = [];
    for (const raw of Array.isArray(state.origins) ? state.origins : []) {
        if (typeof raw?.origin !== "string") continue;
        const localStorage: Array<{ name: string; value: string }> = [];
        for (const item of Array.isArray(raw.localStorage) ? raw.localStorage : []) {
            if (typeof item?.name === "string" && typeof item?.value === "string") {
                localStorage.push({ name: item.name, value: item.value });
            }
        }
        origins.push({ origin: raw.origin, localStorage });
    }

    return { cookies, origins };
}

export type LoadStorageStateResult = {
    storageState: PlaywrightStorageState | null;
    warning: string | null;
};

export function loadPlaywrightStorageState(
    storageStatePath: string | null,
): LoadStorageStateResult {
    if (!storageStatePath) {
        return { storageState: null, warning: null };
    }
    try {
        const inspection = inspectAuthState(storageStatePath);
        if (inspection.status !== "valid") {
            return {
                storageState: null,
                warning: describeAuthStateProblem(inspection),
            };
        }
        const raw = fs.readFileSync(storageStatePath, "utf-8");
        const parsed = JSON.parse(raw) as StorageStateInput;
        return { storageState: sanitizeStorageState(parsed), warning: null };
    } catch {
        return {
            storageState: null,
            warning: "Failed to load storage state for discovery",
        };
    }
}
