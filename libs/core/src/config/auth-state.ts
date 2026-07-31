import * as fs from "node:fs";
import * as path from "node:path";
import { authError } from "../errors";
import { loadAuthConfig } from "./load";
import { resolvePathWithinProject } from "./store";

const DEFAULT_AUTH_STATE_PATH = path.join(".raiken", "auth-state.json");

interface StorageStateCookie {
    name: string;
    value: string;
    expires?: number;
}

interface StorageStateOrigin {
    origin: string;
}

export type AuthStateInspection =
    | {
          status: "missing";
          path: string;
          exists: false;
          expired: false;
          expiresAt: null;
          cookieCount: 0;
          origins: [];
      }
    | {
          status: "malformed";
          path: string;
          exists: true;
          expired: false;
          expiresAt: null;
          cookieCount: 0;
          origins: [];
          error: string;
      }
    | {
          status: "empty" | "valid" | "expired";
          path: string;
          exists: true;
          expired: boolean;
          /** Earliest persistent-cookie expiry, in Unix milliseconds. */
          expiresAt: number | null;
          cookieCount: number;
          origins: string[];
      };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfiguredStorageStatePath(projectPath: string): string | null {
    try {
        const configured = loadAuthConfig(projectPath).storageStatePath;
        if (typeof configured !== "string" || configured.trim().length === 0) return null;
        return resolvePathWithinProject(projectPath, configured.trim());
    } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

/**
 * Resolve where newly captured Playwright state must be written.
 *
 * An explicit configured path is authoritative. Paths outside the project are
 * rejected so a dashboard/config edit cannot make Raiken overwrite arbitrary
 * files on the machine.
 */
export function resolveAuthStorageStateDestination(projectPath: string): string {
    return (
        readConfiguredStorageStatePath(projectPath) ??
        resolvePathWithinProject(projectPath, DEFAULT_AUTH_STATE_PATH)
    );
}

/**
 * Resolve an existing storage-state file for reading.
 *
 * Once a project configures a path, a missing file at that path is not allowed
 * to fall back to the legacy default: doing so creates a split brain where
 * writers and readers silently use different sessions.
 */
export function resolveAuthStorageStatePath(projectPath: string): string | null {
    const configured = readConfiguredStorageStatePath(projectPath);
    if (configured) return fs.existsSync(configured) ? configured : null;

    const fallback = resolvePathWithinProject(projectPath, DEFAULT_AUTH_STATE_PATH);
    return fs.existsSync(fallback) ? fallback : null;
}

export function resolveAuthStorageStateRelativePath(projectPath: string): string | null {
    const statePath = resolveUsableAuthStorageStatePath(projectPath);
    if (!statePath) return null;
    const projectRoot = fs.realpathSync(path.resolve(projectPath));
    return path.relative(projectRoot, statePath).split(path.sep).join("/");
}

/**
 * Inspect a Playwright storage-state file without loading it into a browser.
 *
 * Expiry is reported only when it is provable: the state has cookies, every
 * cookie is persistent, and every cookie has expired. Session cookies and
 * localStorage-only states are treated as potentially usable because their
 * validity cannot be established from the file alone.
 */
export function inspectAuthState(statePath: string): AuthStateInspection {
    const resolved = path.resolve(statePath);
    if (!fs.existsSync(resolved)) {
        return {
            status: "missing",
            path: resolved,
            exists: false,
            expired: false,
            expiresAt: null,
            cookieCount: 0,
            origins: [],
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
        if (
            !isRecord(parsed) ||
            !Array.isArray(parsed["cookies"]) ||
            !Array.isArray(parsed["origins"])
        ) {
            throw new TypeError(
                "expected Playwright storage state with cookies and origins arrays",
            );
        }

        const cookies: StorageStateCookie[] = parsed["cookies"].map((cookie, index) => {
            if (
                !isRecord(cookie) ||
                typeof cookie["name"] !== "string" ||
                typeof cookie["value"] !== "string" ||
                (cookie["expires"] !== undefined && typeof cookie["expires"] !== "number")
            ) {
                throw new TypeError(`cookie ${index + 1} has an invalid shape`);
            }
            return {
                name: cookie["name"],
                value: cookie["value"],
                ...(typeof cookie["expires"] === "number" ? { expires: cookie["expires"] } : {}),
            };
        });

        const origins: StorageStateOrigin[] = parsed["origins"].map((origin, index) => {
            if (!isRecord(origin) || typeof origin["origin"] !== "string") {
                throw new TypeError(`origin ${index + 1} has an invalid shape`);
            }
            return { origin: origin["origin"] };
        });

        const persistentExpiries = cookies
            .map((cookie) => cookie.expires)
            .filter(
                (expires): expires is number =>
                    typeof expires === "number" && Number.isFinite(expires) && expires > 0,
            );
        const hasSessionCookie = cookies.some(
            (cookie) =>
                cookie.expires === undefined ||
                !Number.isFinite(cookie.expires) ||
                cookie.expires <= 0,
        );
        const nowSeconds = Date.now() / 1000;
        const expired =
            cookies.length > 0 &&
            !hasSessionCookie &&
            persistentExpiries.length === cookies.length &&
            persistentExpiries.every((expires) => expires <= nowSeconds);
        const expiresAt =
            persistentExpiries.length > 0 ? Math.min(...persistentExpiries) * 1000 : null;
        const status =
            cookies.length === 0 && origins.length === 0 ? "empty" : expired ? "expired" : "valid";

        return {
            status,
            path: resolved,
            exists: true,
            expired,
            expiresAt,
            cookieCount: cookies.length,
            origins: origins.map((origin) => origin.origin),
        };
    } catch (error) {
        return {
            status: "malformed",
            path: resolved,
            exists: true,
            expired: false,
            expiresAt: null,
            cookieCount: 0,
            origins: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function resolveUsableAuthStorageStatePath(projectPath: string): string | null {
    const statePath = resolveAuthStorageStatePath(projectPath);
    if (!statePath) return null;
    const inspection = inspectAuthState(statePath);
    return inspection.status === "valid" ? statePath : null;
}

export function describeAuthStateProblem(inspection: AuthStateInspection): string | null {
    switch (inspection.status) {
        case "missing":
            return `Saved auth state is missing at ${inspection.path}. Run \`raiken auth\` to create it.`;
        case "malformed":
            return `Saved auth state at ${inspection.path} is malformed (${inspection.error}). Run \`raiken auth\` to replace it.`;
        case "empty":
            return `Saved auth state at ${inspection.path} contains no cookies or origins. Run \`raiken auth\` to capture a real session.`;
        case "expired": {
            const when = inspection.expiresAt
                ? ` on ${new Date(inspection.expiresAt).toISOString()}`
                : "";
            return `Saved auth state at ${inspection.path} expired${when}. Run \`raiken auth\` to refresh it.`;
        }
        case "valid":
            return null;
    }
}

/**
 * Validate and atomically replace a storage-state file. The previous session
 * remains intact when the new snapshot is empty, malformed, or expired.
 */
export function writeValidatedAuthState(
    destination: string,
    state: unknown,
): AuthStateInspection & { status: "valid" } {
    const resolved = path.resolve(destination);
    const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    try {
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });
        const inspection = inspectAuthState(temporary);
        if (inspection.status !== "valid") {
            throw authError(
                describeAuthStateProblem(inspection) ??
                    "Captured auth state is not usable. Complete login and try again.",
                { code: "AUTH_STATE_INVALID", cause: inspection },
            );
        }
        fs.renameSync(temporary, resolved);
        fs.chmodSync(resolved, 0o600);
        return { ...inspection, status: "valid", path: resolved };
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}
