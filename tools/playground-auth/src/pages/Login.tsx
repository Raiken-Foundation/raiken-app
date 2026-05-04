import { type FormEvent, useState } from "react";

export default function Login() {
    const [error, setError] = useState("");

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
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            redirect: "follow",
        });

        if (res.ok || res.redirected) {
            window.location.href = res.url || "/dashboard";
        } else {
            setError("Sign-in failed. Please try again.");
        }
    };

    return (
        <div className="login-wrapper" data-testid="login-page">
            <div className="login-card">
                <h1>Welcome back</h1>
                <p className="subtitle">Sign in to Acme Corp internal portal</p>

                <form
                    data-testid="login-form"
                    onSubmit={handleSubmit}
                    method="POST"
                    action="/auth/callback/credentials"
                >
                    <div className="form-group">
                        <label htmlFor="username">Username</label>
                        <input
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
                        <p
                            role="alert"
                            data-testid="login-error"
                            style={{ color: "var(--danger)", fontSize: ".8rem", marginBottom: ".75rem" }}
                        >
                            {error}
                        </p>
                    )}

                    <button type="submit" className="btn-primary" data-testid="login-submit">
                        Sign in
                    </button>
                </form>

                <p className="login-hint">Use any username (≥ 3 chars) and any password (≥ 4 chars).</p>
            </div>
        </div>
    );
}
