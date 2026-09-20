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
        // Playwright's context creation HARD-REJECTS cookie shapes the old
        // sanitizer passed through (verified against playwright-core 1.57
        // rewriteCookies asserts): a cookie with neither `url` nor `domain`,
        // `domain` without `path`, or `expires < -1`. With a storageState
        // loaded, every newPage() then throws and the whole authenticated
        // crawl produces zero pages (review finding).
        const hasDomain = typeof r["domain"] === "string" && (r["domain"] as string) !== "";
        if (!hasDomain && typeof r["url"] !== "string") {
            continue;
        }
        const pathValue =
            typeof r["path"] === "string"
                ? (r["path"] as string)
                : hasDomain
                  ? "/"
                  : undefined;
        let expires: number | undefined =
            typeof r["expires"] === "number" ? (r["expires"] as number) : undefined;
        if (expires !== undefined && expires < -1) {
            expires = -1;
        }
        let secure: boolean | undefined =
            typeof r["secure"] === "boolean" ? (r["secure"] as boolean) : undefined;
        if (sameSite === "None" && !secure) {
            // Chromium silently drops None-without-secure cookies, partially
            // loading the session — force the flag the cookie implies.
            secure = true;
        }
        cookies.push({
            name: r["name"] as string,
            value: r["value"] as string,
            domain: hasDomain ? (r["domain"] as string) : undefined,
            path: pathValue,
            url: typeof r["url"] === "string" ? (r["url"] as string) : undefined,
            expires,
            httpOnly: typeof r["httpOnly"] === "boolean" ? (r["httpOnly"] as boolean) : undefined,
            secure,
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
