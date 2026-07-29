import { type FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LOGIN_HINTS } from "../auth/fixture";

export default function Login() {
    const [searchParams] = useSearchParams();
    const [error, setError] = useState("");
    const expired = searchParams.get("reason") === "expired";
    const usernameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        usernameRef.current?.focus();
    }, []);

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError("");

        const form = e.currentTarget;
        const username = (form.elements.namedItem("username") as HTMLInputElement).value.trim();
        const password = (form.elements.namedItem("password") as HTMLInputElement).value;

        if (username.length < 3) {
            setError("Username must be at least 3 characters.");
            return;
        }
        if (password.length < 4) {
            setError("Password must be at least 4 characters.");
            return;
        }

        const body = new URLSearchParams({ username, password });
        const res = await fetch("/auth/callback/credentials", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: body.toString(),
            redirect: "manual",
            credentials: "same-origin",
        });

        if (res.status === 401 || res.status === 403) {
            const data = (await res.json()) as { message?: string };
            setError(data.message ?? "Sign-in failed. Please try again.");
            return;
        }

        if (res.ok) {
            const data = (await res.json()) as { redirect?: string };
            window.location.assign(data.redirect ?? "/dashboard");
            return;
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("Location") ?? "/dashboard";
            window.location.assign(location);
            return;
        }

        setError("Sign-in failed. Please try again.");
    };

    return (
        <div className="login-wrapper" data-testid="login-page">
            <div className="login-card">
                <h1>Welcome back</h1>
                <p className="subtitle">Sign in to Acme Corp internal portal</p>

                {expired && (
                    <output className="banner banner-warning" data-testid="session-expired-banner">
                        Your session expired. Sign in again to continue.
                    </output>
                )}

                <form
                    data-testid="login-form"
                    onSubmit={handleSubmit}
                    method="POST"
                    action="/auth/callback/credentials"
                >
                    <div className="form-group">
                        <label htmlFor="username">Username</label>
                        <input
                            ref={usernameRef}
                            id="username"
                            name="username"
                            type="text"
                            autoComplete="username"
                            data-testid="username-input"
                            placeholder="your-username"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            data-testid="password-input"
                            required
                        />
                    </div>

                    {error && (
                        <p role="alert" data-testid="login-error" className="form-error">
                            {error}
                        </p>
                    )}

                    <button type="submit" className="btn-primary" data-testid="login-submit">
                        Sign in
                    </button>
                </form>

                <div className="login-hints" data-testid="login-hints">
                    <p className="login-hints-title">
                        Fixture accounts (password: <code>password</code>)
                    </p>
                    <ul>
                        {LOGIN_HINTS.map((hint) => (
                            <li key={hint.username} data-testid={`login-hint-${hint.username}`}>
                                <strong>{hint.username}</strong> — {hint.role}
                                {hint.mfaRequired && " · MFA required"}
                                {hint.locked && " · locked"}
                                {hint.shortLived && " · short-lived session"}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}
