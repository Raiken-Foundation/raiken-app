import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useSession } from "./useSession";

export default function ProtectedLayout() {
    const { session, loading, failure } = useSession();

    useEffect(() => {
        if (loading) return;
        if (!session) {
            const suffix = failure === "session_expired" ? "?reason=expired" : "";
            window.location.replace(`/auth/login${suffix}`);
            return;
        }

        const remaining = session.exp - Date.now();
        if (remaining <= 0) {
            window.location.replace("/auth/login?reason=expired");
            return;
        }

        const expiryTimer = window.setTimeout(() => {
            window.location.replace("/auth/login?reason=expired");
        }, remaining);
        return () => window.clearTimeout(expiryTimer);
    }, [failure, loading, session]);

    if (loading || !session) {
        return (
            <main className="session-gate" data-testid="session-gate" aria-live="polite">
                Verifying session…
            </main>
        );
    }

    return <Outlet />;
}
