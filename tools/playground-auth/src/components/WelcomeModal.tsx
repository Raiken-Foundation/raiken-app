import { useEffect, useRef } from "react";

const STORAGE_KEY = "playground-auth-welcome-dismissed";

interface WelcomeModalProps {
    username: string;
    role: string;
}

export default function WelcomeModal({ username, role }: WelcomeModalProps) {
    const dismissRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        dismissRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                sessionStorage.setItem(STORAGE_KEY, "1");
                window.dispatchEvent(new CustomEvent("welcome-dismissed"));
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const dismiss = () => {
        sessionStorage.setItem(STORAGE_KEY, "1");
        window.dispatchEvent(new CustomEvent("welcome-dismissed"));
    };

    return (
        <div className="modal-overlay" data-testid="welcome-modal-overlay">
            <div
                className="modal-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="welcome-modal-title"
                data-testid="welcome-modal"
            >
                <h2 id="welcome-modal-title">Welcome, {username}</h2>
                <p className="modal-desc">
                    You are signed in as <strong>{role}</strong>. This modal appears once per
                    browser session after login.
                </p>
                <button
                    ref={dismissRef}
                    type="button"
                    className="btn-primary"
                    data-testid="welcome-modal-dismiss"
                    onClick={dismiss}
                >
                    Continue to dashboard
                </button>
            </div>
        </div>
    );
}

export function shouldShowWelcomeModal(): boolean {
    return sessionStorage.getItem(STORAGE_KEY) !== "1";
}
