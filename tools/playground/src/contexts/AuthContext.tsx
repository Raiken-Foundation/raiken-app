import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import type { Role, Session, User } from "../types";
import * as api from "../api";

/**
 * Client-side session for the fixture. Persisted to localStorage so a
 * Playwright storageState captured after login carries the session — that is
 * how `raiken auth` sessions work against this app.
 */
const STORAGE_KEY = "orbit.session.v1";

interface AuthContextValue {
    session: Session | null;
    user: User | null;
    login: (username: string, password: string) => Promise<User>;
    logout: () => void;
    /** RBAC helpers — the UI hides what the API also rejects. */
    can: (action: "write" | "manage") => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): Session | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Session;
        if (!parsed?.user?.id) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session | null>(() => readStoredSession());

    useEffect(() => {
        if (session) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    }, [session]);

    const login = useCallback(async (username: string, password: string) => {
        const result = await api.login(username, password);
        const next: Session = { user: result.user, issuedAt: result.issuedAt };
        setSession(next);
        return next.user;
    }, []);

    const logout = useCallback(() => setSession(null), []);

    const can = useCallback(
        (action: "write" | "manage") => {
            if (!session) return false;
            const role: Role = session.user.role;
            if (action === "write") return role === "admin" || role === "member";
            return role === "admin";
        },
        [session],
    );

    const value = useMemo<AuthContextValue>(
        () => ({ session, user: session?.user ?? null, login, logout, can }),
        [session, login, logout, can],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
    return ctx;
}
