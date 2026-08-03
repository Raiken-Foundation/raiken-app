export type Role = "admin" | "member" | "viewer";

export type Permission =
    | "manage:workspace"
    | "manage:projects"
    | "manage:members"
    | "edit:projects"
    | "read:projects";

export interface FixtureUser {
    username: string;
    password: string;
    name: string;
    role: Role;
    permissions: Permission[];
    mfaRequired?: boolean;
    locked?: boolean;
    sessionTtlMs?: number;
}

export const MFA_CODE = "123456";

export const DEFAULT_SESSION_TTL_MS = 86_400_000;
export const EXPIRING_SESSION_TTL_MS = 1_750;
export const MFA_PENDING_TTL_MS = 600_000;
export const REAUTH_PROOF_TTL_MS = 300_000;

export const FIXTURE_USERS: Record<string, FixtureUser> = {
    admin: {
        username: "admin",
        password: "password",
        name: "Admin User",
        role: "admin",
        permissions: ["manage:workspace", "manage:projects", "manage:members"],
    },
    member: {
        username: "member",
        password: "password",
        name: "Member User",
        role: "member",
        permissions: ["edit:projects"],
    },
    viewer: {
        username: "viewer",
        password: "password",
        name: "Viewer User",
        role: "viewer",
        permissions: ["read:projects"],
    },
    "mfa-admin": {
        username: "mfa-admin",
        password: "password",
        name: "MFA Admin",
        role: "admin",
        permissions: ["manage:workspace", "manage:projects", "manage:members"],
        mfaRequired: true,
    },
    locked: {
        username: "locked",
        password: "password",
        name: "Locked User",
        role: "member",
        permissions: ["edit:projects"],
        locked: true,
    },
    expiring: {
        username: "expiring",
        password: "password",
        name: "Expiring Admin",
        role: "admin",
        permissions: ["manage:workspace", "manage:projects", "manage:members"],
        sessionTtlMs: EXPIRING_SESSION_TTL_MS,
    },
};

/** Credential hints shown on the login page (no passwords). */
export const LOGIN_HINTS = Object.values(FIXTURE_USERS).map((user) => ({
    username: user.username,
    role: user.role,
    mfaRequired: Boolean(user.mfaRequired),
    locked: Boolean(user.locked),
    shortLived: user.sessionTtlMs === EXPIRING_SESSION_TTL_MS,
}));

export function findFixtureUser(username: string): FixtureUser | undefined {
    return Object.values(FIXTURE_USERS).find((user) => user.username === username);
}

export type CredentialValidation =
    | { ok: true; user: FixtureUser }
    | { ok: false; error: "invalid_credentials" | "locked"; message: string };

export function validateCredentials(username: string, password: string): CredentialValidation {
    const user = findFixtureUser(username);
    if (!user || user.password !== password) {
        return {
            ok: false,
            error: "invalid_credentials",
            message: "Invalid username or password.",
        };
    }
    if (user.locked) {
        return {
            ok: false,
            error: "locked",
            message: "This account is locked. Contact an administrator.",
        };
    }
    return { ok: true, user };
}

export interface SessionPayload {
    user: string;
    name: string;
    role: Role;
    permissions: Permission[];
    exp: number;
}

export function sessionTtlForUser(user: FixtureUser): number {
    return user.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
}

export function buildSessionPayload(user: FixtureUser): SessionPayload {
    return {
        user: user.username,
        name: user.name,
        role: user.role,
        permissions: user.permissions,
        exp: Date.now() + sessionTtlForUser(user),
    };
}
