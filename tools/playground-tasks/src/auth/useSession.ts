import { useCallback, useEffect, useState } from "react";
import type { Permission, Role } from "./fixture";

export interface AuthSession {
    user: string;
    name: string;
    role: Role;
    permissions: Permission[];
    exp: number;
}

export function useSession() {
    const [session, setSession] = useState<AuthSession | null>(null);
    const [loading, setLoading] = useState(true);
    const [failure, setFailure] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setFailure(null);
        try {
            const response = await fetch("/auth/session", {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });
            if (!response.ok) {
                const data = (await response.json().catch(() => null)) as { error?: string } | null;
                setSession(null);
                setFailure(data?.error ?? "unauthenticated");
                return;
            }
            const data = (await response.json()) as AuthSession;
            setSession(data);
        } catch {
            setSession(null);
            setFailure("network_error");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const hasPermission = useCallback(
        (permission: Permission) => session?.permissions.includes(permission) ?? false,
        [session],
    );

    return { session, loading, failure, refresh, hasPermission };
}
