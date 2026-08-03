import { type FormEvent, useEffect, useRef, useState } from "react";

interface ReauthDialogProps {
    onCancel: () => void;
    onSuccess: () => void;
}

export default function ReauthDialog({ onCancel, onSuccess }: ReauthDialogProps) {
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const passwordRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        passwordRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !submitting) onCancel();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [onCancel, submitting]);

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError("");
        setSubmitting(true);

        const password = passwordRef.current?.value ?? "";
        const body = new URLSearchParams({ password });

        try {
            const response = await fetch("/auth/reauth", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
                body: body.toString(),
                credentials: "same-origin",
            });

            if (!response.ok) {
                const data = (await response.json()) as { message?: string };
                setError(data.message ?? "Incorrect password.");
                return;
            }

            onSuccess();
        } catch {
            setError("Reauthentication failed. Please try again.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="modal-overlay" data-testid="reauth-dialog-overlay">
            <div
                className="modal-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="reauth-dialog-title"
                data-testid="reauth-dialog"
            >
                <h2 id="reauth-dialog-title">Confirm your password</h2>
                <p className="modal-desc">
                    Re-enter your password to authorize this destructive action.
                </p>
                <form onSubmit={handleSubmit} data-testid="reauth-form">
                    <div className="form-group">
                        <label htmlFor="reauth-password">Password</label>
                        <input
                            ref={passwordRef}
                            id="reauth-password"
                            type="password"
                            autoComplete="current-password"
                            data-testid="reauth-password-input"
                            required
                        />
                    </div>
                    {error && (
                        <p role="alert" data-testid="reauth-error" className="form-error">
                            {error}
                        </p>
                    )}
                    <div className="modal-actions">
                        <button
                            type="button"
                            className="btn-secondary"
                            data-testid="reauth-cancel"
                            onClick={onCancel}
                            disabled={submitting}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="btn-danger"
                            data-testid="reauth-submit"
                            disabled={submitting}
                        >
                            Confirm password
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
