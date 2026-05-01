import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ApiError, login as apiLogin } from "../api";
import type { User } from "../types";

interface AuthContextValue {
    user: User | null;
    isLoggedIn: boolean;
    isAdmin: boolean;
    login: (username: string, password: string) => Promise<User>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "playground.auth.user";

function readPersisted(): User | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as User;
    } catch {
        return null;
    }
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(() => readPersisted());

    const login = useCallback(async (username: string, password: string) => {
        try {
            const u = await apiLogin({ username, password });
            setUser(u);
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
            } catch {
                // localStorage may be unavailable in private windows
            }
            return u;
        } catch (err) {
            if (err instanceof ApiError) throw err;
            throw new ApiError("login failed", "network");
        }
    }, []);

    const logout = useCallback(() => {
        setUser(null);
        try {
            window.localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
    }, []);

    const value = useMemo<AuthContextValue>(
        () => ({
            user,
            isLoggedIn: user !== null,
            isAdmin: user?.role === "admin",
            login,
            logout,
        }),
        [user, login, logout],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
    return ctx;
}
